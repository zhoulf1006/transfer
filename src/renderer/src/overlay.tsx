import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ShotSource } from '@shared/ipc'
import {
  rectFromPoints,
  clampRect,
  hitTest,
  applyDrag,
  nudge,
  isValidSelection,
  anchorLevel,
  type Rect,
  type Handle,
  type Anchor
} from '@shared/screenshot-selection'
import {
  logicalToPixel,
  clampPixel,
  formatColor,
  clampZoom,
  type ColorFormat
} from '@shared/screenshot-color'
import { cropRect } from '@shared/screenshot-geometry'
import {
  emptyScene,
  commit,
  undo as undoScene,
  redo as redoScene,
  clearAll,
  type ShotTool,
  type ShotElement,
  type ShotStyle,
  type SceneState
} from '@shared/screenshot-annotation'
import { drawElement } from './annotation-draw'
import { CopyIcon, SaveIcon, SendIcon } from './icons'

/**
 * 截图遮罩层(见 docs/screenshot-feature §4.1)。
 *
 * 阶段3:手动框选 + 内亮外暗 + W×H + 拖锚点/拖整块 + 方向键微调 + 右键重选 + 锚点隐藏。
 * 几何全走 @shared/screenshot-selection 纯函数。放大镜/标注在后续阶段。
 */
function Overlay(): JSX.Element {
  const [shot, setShot] = useState<ShotSource | null>(null)

  useEffect(() => {
    const unsubShow = window.transfer.shot.onShow(() => {
      // 先清空再拉新:即便上次 shotHide 丢失,也不会在新背景到达前露出旧选区框。
      setShot(null)
      window.transfer.shot.getShot().then((s) => setShot(s))
    })
    // 会话结束清空 shot:遮罩窗 hide 复用,不清下次 show 会闪上次选区框(§4.7)。
    const unsubHide = window.transfer.shot.onHide(() => setShot(null))
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.transfer.shot.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      unsubShow()
      unsubHide()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  if (!shot) {
    return (
      <div style={S.mask}>
        <div style={S.hint}>正在截图…</div>
      </div>
    )
  }
  return <Session key={shot.shotId} shot={shot} />
}

type DragMode =
  | { kind: 'creating'; x0: number; y0: number }
  | { kind: 'handle'; handle: Handle; startPx: number; startPy: number; startRect: Rect }
  | null

let elementSeq = 0
const nextId = (): string => `el${++elementSeq}`

/** 文字字号:随粗细轻微变化(默认 width=3 → 18px),textarea 与提交的 element 用同一算法保持一致。 */
const textFontSize = (width: number): number => 12 + width * 2

/** 按工具在按下点创建一个初始 element(拖拽/移动中由 updateElement 更新终点)。 */
function startElement(
  tool: ShotTool,
  p: { x: number; y: number },
  style: ShotStyle,
  badgeN: number
): ShotElement {
  const id = nextId()
  switch (tool) {
    case 'rect':
    case 'ellipse':
    case 'mosaic':
    case 'blur':
      return { id, type: tool, x: p.x, y: p.y, w: 0, h: 0, style }
    case 'line':
    case 'arrow':
      return { id, type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, style }
    case 'pen':
    case 'marker':
      return { id, type: tool, points: [[p.x, p.y]], style }
    case 'text':
      return { id, type: 'text', x: p.x, y: p.y, text: '', fontSize: textFontSize(style.width), style }
    case 'badge':
      return { id, type: 'badge', cx: p.x, cy: p.y, n: badgeN + 1, style }
  }
}

/**
 * 拖拽中更新 element 的终点/尺寸(就地改,画完才 commit)。
 * anchor 为按下点(rect 类反向拖时用它归一,保证正矩形)。
 */
function updateElement(el: ShotElement, p: { x: number; y: number }, anchor: { x: number; y: number }): void {
  switch (el.type) {
    case 'rect':
    case 'ellipse':
    case 'mosaic':
    case 'blur': {
      const r = rectFromPoints(anchor.x, anchor.y, p.x, p.y)
      el.x = r.x
      el.y = r.y
      el.w = r.w
      el.h = r.h
      break
    }
    case 'line':
    case 'arrow':
      el.x2 = p.x
      el.y2 = p.y
      break
    case 'pen':
    case 'marker':
      el.points.push([p.x, p.y])
      break
    case 'text':
    case 'badge':
      break // 点击型,不随拖拽变
  }
}

/** 画完的 element 是否有效(太小/空的丢弃)。 */
function isElementValid(el: ShotElement): boolean {
  switch (el.type) {
    case 'rect':
    case 'ellipse':
    case 'mosaic':
    case 'blur':
      return el.w >= 3 && el.h >= 3
    case 'line':
    case 'arrow':
      return Math.hypot(el.x2 - el.x1, el.y2 - el.y1) >= 3
    case 'pen':
    case 'marker':
      return el.points.length >= 2
    case 'text':
      return el.text.length > 0
    case 'badge':
      return true
  }
}

/** 一次截图会话(shotId 变 → 整体重挂,天然复位)。 */
function Session({ shot }: { shot: ShotSource }): JSX.Element {
  const bounds = { w: shot.displayW, h: shot.displayH }
  const ratio = { x: shot.ratioX, y: shot.ratioY }
  const [sel, setSel] = useState<Rect | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState(8)
  const [fmt, setFmt] = useState<ColorFormat>('hex')
  const drag = useRef<DragMode>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // 离屏采样 canvas:背景物理位图画进来,供放大镜 getImageData 取色(§2.4)。
  const sampleRef = useRef<HTMLCanvasElement | null>(null)

  // ── 标注(§4.4)──
  const [tool, setTool] = useState<ShotTool | null>(null) // null=无工具(纯框选态,可调选区)
  const [style, setStyle] = useState<ShotStyle>({ color: '#e23b3b', width: 2, alpha: 1 })
  const [scene, setScene] = useState<SceneState>(emptyScene)
  const annoRef = useRef<HTMLCanvasElement | null>(null)
  // 正在画的临时 element + 按下锚点(rect 类反向拖归一用)
  const drawing = useRef<{ el: ShotElement; anchor: { x: number; y: number } } | null>(null)
  // 文字标注:点击后在该点开一个 textarea 收字,提交转成 text element(§3.3)。
  const [textEdit, setTextEdit] = useState<{ x: number; y: number; value: string } | null>(null)
  const [textEditKey, setTextEditKey] = useState(0) // 每次开框自增,驱动聚焦 effect 重跑
  const textRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const cv = document.createElement('canvas')
    cv.width = shot.bitmapW
    cv.height = shot.bitmapH
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    const img = new Image()
    img.onload = () => {
      ctx?.drawImage(img, 0, 0) // 物理像素 1:1,不缩放(§3.3)
      sampleRef.current = cv
    }
    img.src = shot.dataUrl
    return () => {
      sampleRef.current = null
    }
  }, [shot.dataUrl, shot.bitmapW, shot.bitmapH])

  // 从鼠标事件取遮罩内逻辑坐标(遮罩铺满 display,故 clientX/Y 即逻辑坐标)。
  const pt = (e: React.PointerEvent | PointerEvent): { x: number; y: number } => {
    const r = rootRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const inSel = (p: { x: number; y: number }): boolean =>
    !!sel && p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button === 2) return // 右键交给 contextmenu 处理(重选)
    const p = pt(e)
    // 有未提交的文字框时,任意点击(切工具/画别的)先提交它(替代 onBlur 提交,见 §3.3)。
    if (textEdit) commitTextEdit()
    // 文字工具:点选区内 → 开 textarea 收字。
    // 不 setPointerCapture:否则 root 抓住指针,textarea 拿不到焦点/立刻失焦。
    if (tool === 'text' && sel && inSel(p)) {
      openTextEdit(p.x, p.y)
      return
    }
    rootRef.current?.setPointerCapture(e.pointerId)
    // 其他标注工具 且 点在选区内 → 拖拽/点击画标注(不动选区)
    if (tool && sel && inSel(p)) {
      drawing.current = { el: startElement(tool, p, style, scene.badgeCounter), anchor: p }
      return
    }
    if (sel) {
      const h = hitTest(sel, p.x, p.y, HANDLE_TOL)
      if (h) {
        drag.current = { kind: 'handle', handle: h, startPx: p.x, startPy: p.y, startRect: sel }
        return
      }
    }
    // 无选区或点在选区外 → 开始新框选
    drag.current = { kind: 'creating', x0: p.x, y0: p.y }
    setSel({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const p = pt(e)
    setHover(p) // 放大镜跟指针(框选前)
    if (drawing.current) {
      updateElement(drawing.current.el, p, drawing.current.anchor)
      redrawAnno(drawing.current.el) // 实时预览当前笔
      return
    }
    const d = drag.current
    if (!d) return
    if (d.kind === 'creating') {
      setSel(clampRect(rectFromPoints(d.x0, d.y0, p.x, p.y), bounds))
    } else {
      const next = applyDrag(d.startRect, d.handle, p.x - d.startPx, p.y - d.startPy)
      setSel(clampRect(next, bounds))
    }
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    rootRef.current?.releasePointerCapture(e.pointerId)
    // 画完一笔 → commit 到场景(badge 递增)
    if (drawing.current) {
      const el = drawing.current.el
      drawing.current = null
      if (isElementValid(el)) {
        setScene((s) => {
          const next = commit(s, [...s.elements, el])
          return el.type === 'badge' ? { ...next, badgeCounter: s.badgeCounter + 1 } : next
        })
      } else {
        redrawAnno(null) // 无效笔,清掉预览
      }
      return
    }
    // 框选结束若太小视为无效 → 清空(回到未选区态)
    if (drag.current?.kind === 'creating' && sel && !isValidSelection(sel)) setSel(null)
    drag.current = null
  }

  // 右键:标注中(有工具/有笔)→ 撤销一步;纯框选态有选区→重选,无选区→取消(§2.3/§4.7)
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if (tool || scene.elements.length > 0) setScene((s) => undoScene(s))
    else if (sel) setSel(null)
    else window.transfer.shot.cancel()
  }

  // 逻辑矩形 → 底图物理像素矩形(马赛克/模糊从底图取区域)。
  const pxRect = (x: number, y: number, w: number, h: number): { sx: number; sy: number; sw: number; sh: number } =>
    cropRect({ x, y, w, h }, ratio, { width: shot.bitmapW, height: shot.bitmapH })

  // 重绘标注层:场景所有 element +(可选)正在画的临时笔。ctx 平移到选区原点。
  const redrawAnno = (inProgress: ShotElement | null): void => {
    const cv = annoRef.current
    if (!cv || !sel) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(1, 0, 0, 1, 0, 0) // 先复位变换,清整块 backing store(否则平移后清不到左上)
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.setTransform(dpr, 0, 0, dpr, -sel.x * dpr, -sel.y * dpr) // 选区原点 + dpr 锐化
    const els = inProgress ? [...scene.elements, inProgress] : scene.elements
    // clearRect 已在上面做,drawScene 内部的 clear 传 0(不再重复清,避免坐标系不符)
    for (const el of els) drawElement(ctx, el, sampleRef.current, pxRect, 1)
  }

  // 打开(或换位置重开)文字框:统一入口,开完 rAF 聚焦(DOM 挂载后)。
  // 用 textEditKey 唯一标识每个框:连续点两处时 textEdit 直接 {旧}→{新}(textOpen 始终 true),
  // 若靠 boolean 依赖 effect 不会重跑 → 只第一次聚焦。key 每次自增,保证每个新框都聚焦。
  const openTextEdit = (x: number, y: number): void => {
    setTextEditKey((k) => k + 1)
    setTextEdit({ x, y, value: '' })
  }
  useEffect(() => {
    if (textEdit === null) return
    const id = requestAnimationFrame(() => textRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [textEditKey])

  // 提交文字编辑:非空则转成 text element 入场景;空则丢弃。
  const commitTextEdit = (): void => {
    setTextEdit((te) => {
      if (te && te.value.trim()) {
        const el: ShotElement = {
          id: nextId(),
          type: 'text',
          x: te.x,
          y: te.y,
          text: te.value,
          fontSize: textFontSize(style.width),
          style
        }
        setScene((s) => commit(s, [...s.elements, el]))
      }
      return null
    })
  }

  // 场景/选区变化时重绘标注层。
  useEffect(() => {
    redrawAnno(null)
    // redrawAnno 依赖闭包内 scene/sel;显式列关键依赖
  }, [scene, sel?.x, sel?.y, sel?.w, sel?.h])

  // 撤销/重做键位(§4.7):Ctrl+Z / Ctrl+Shift+Z(重做)/ Ctrl+Y(重做)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault()
        setScene((s) => (e.shiftKey ? redoScene(s) : undoScene(s)))
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault()
        setScene((s) => redoScene(s))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 方向键像素微调(§2.3):仅"无标注工具"时调选区;选了工具则方向键留给标注(暂不用)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!sel || tool) return
      const map: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      }
      const dir = map[e.key]
      if (!dir) return
      e.preventDefault()
      const mod = e.ctrlKey || e.metaKey ? 'expand' : e.shiftKey ? 'shrink' : 'move'
      setSel((cur) => (cur ? clampRect(nudge(cur, dir[0], dir[1], mod), bounds) : cur))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel, tool, bounds.w, bounds.h])

  const valid = sel && isValidSelection(sel)
  const level = sel ? anchorLevel(sel) : 'none'

  // 放大镜生命周期(§4.7):有有效锁定选区后消失(取色仅框选前/框选中对边)。
  const showMag = !valid && hover !== null

  // hover 处像素颜色(从离屏采样 canvas 取)。
  const colorAt = (lx: number, ly: number): [number, number, number] | null => {
    const cv = sampleRef.current
    if (!cv) return null
    const raw = logicalToPixel(lx, ly, ratio)
    const { px, py } = clampPixel(raw.px, raw.py, shot.bitmapW, shot.bitmapH)
    const d = cv.getContext('2d')?.getImageData(px, py, 1, 1).data
    return d ? [d[0], d[1], d[2]] : null
  }

  // 滚轮调放大倍率(仅放大镜可见时,§4.7)。overlay 无滚动,不需 preventDefault(避免 passive 警告)。
  const onWheel = (e: React.WheelEvent): void => {
    if (!showMag) return
    setZoom((z) => clampZoom(z + (e.deltaY < 0 ? 1 : -1)))
  }

  // C 复制颜色、Shift 切 RGB↔HEX(放大镜可见时,§2.4)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!showMag || !hover) return
      if (e.key === 'c' || e.key === 'C') {
        const rgb = colorAt(hover.x, hover.y)
        if (rgb) void navigator.clipboard.writeText(formatColor(rgb[0], rgb[1], rgb[2], fmt))
      } else if (e.key === 'Shift') {
        setFmt((f) => (f === 'hex' ? 'rgb' : 'hex'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // colorAt/hover 依赖闭包;showMag/fmt 触发重绑
  }, [showMag, hover, fmt])

  /**
   * 导出选区为 PNG(§4.4 导出):独立离屏 canvas 按物理像素尺寸裁底图 + 叠加标注。
   * 标注坐标是逻辑坐标,导出层按物理尺寸:translate 选区原点 + scale(ratio),尺寸量 × min(ratio)。
   */
  const exportPng = async (): Promise<Uint8Array | null> => {
    const sample = sampleRef.current
    if (!sample || !sel || !valid) return null
    const { sx, sy, sw, sh } = cropRect(sel, ratio, { width: shot.bitmapW, height: shot.bitmapH })
    if (sw <= 0 || sh <= 0) return null
    const out = document.createElement('canvas')
    out.width = sw
    out.height = sh
    const ctx = out.getContext('2d')!
    ctx.drawImage(sample, sx, sy, sw, sh, 0, 0, sw, sh)
    // 叠加标注:元素坐标是逻辑坐标,setTransform 平移到选区原点 + × ratio 到物理像素。
    // 变换已负责缩放几何与线宽,故 drawScene 的 sizeScale=1(不再二次乘)。
    // 未提交的文字编辑也一并画进去(避免"打了字直接点复制"漏掉)。
    const els = [...scene.elements]
    if (textEdit && textEdit.value.trim()) {
      els.push({
        id: 'text-pending',
        type: 'text',
        x: textEdit.x,
        y: textEdit.y,
        text: textEdit.value,
        fontSize: textFontSize(style.width),
        style
      })
    }
    ctx.save()
    ctx.setTransform(ratio.x, 0, 0, ratio.y, -sel.x * ratio.x, -sel.y * ratio.y)
    // 用 drawElement 逐个画,不用 drawScene(它内部 clearRect 会擦掉刚画的底图)。
    for (const el of els) drawElement(ctx, el, sample, pxRect, 1)
    ctx.restore()
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'))
    if (!blob) return null
    return new Uint8Array(await blob.arrayBuffer())
  }

  // 三出口:导出失败(采样未就绪/选区失效)也收起遮罩,不静默卡住。
  const doCopy = async (): Promise<void> => {
    const png = await exportPng()
    if (png) await window.transfer.shot.toClipboard(png)
    else window.transfer.shot.cancel()
  }
  const doSave = async (): Promise<void> => {
    const png = await exportPng()
    if (png) await window.transfer.shot.saveAs(png)
    else window.transfer.shot.cancel()
  }
  const doSend = async (): Promise<void> => {
    const png = await exportPng()
    if (png) await window.transfer.shot.sendToChat(png)
    else window.transfer.shot.cancel()
  }

  return (
    <div
      ref={rootRef}
      style={S.root}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
      onWheel={onWheel}
    >
      <img src={shot.dataUrl} style={S.bg} draggable={false} alt="" />
      {/* 四块压暗遮住选区外(选区内保持原图明亮);无选区时整屏压暗 */}
      {sel && valid ? <DimAround sel={sel} /> : <div style={S.dimFull} />}
      {sel && valid && (
        <>
          {/* 标注层:铺在选区上,pointerEvents:none 让事件穿透到 root 统一处理绘制 */}
          <canvas
            ref={annoRef}
            width={Math.round(sel.w * (window.devicePixelRatio || 1))}
            height={Math.round(sel.h * (window.devicePixelRatio || 1))}
            style={{
              position: 'absolute',
              left: sel.x,
              top: sel.y,
              width: sel.w,
              height: sel.h,
              pointerEvents: 'none'
            }}
          />
          <div style={{ ...S.selBox, left: sel.x, top: sel.y, width: sel.w, height: sel.h }} />
          <SizeLabel sel={sel} />
          {level !== 'none' && !tool && <Anchors sel={sel} level={level} />}
          <Toolbar
            sel={sel}
            bounds={bounds}
            hasPeer={shot.hasActivePeer}
            tool={tool}
            style={style}
            canUndo={scene.undoStack.length > 0}
            canRedo={scene.redoStack.length > 0}
            onTool={setTool}
            onStyle={setStyle}
            onUndo={() => setScene((s) => undoScene(s))}
            onRedo={() => setScene((s) => redoScene(s))}
            onClear={() => setScene((s) => clearAll(s))}
            onCopy={doCopy}
            onSave={doSave}
            onSend={doSend}
          />
        </>
      )}
      {textEdit && (
        <textarea
          ref={textRef}
          value={textEdit.value}
          rows={1}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setTextEdit((te) => (te ? { ...te, value: e.target.value } : te))}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commitTextEdit()
            } else if (e.key === 'Escape') {
              setTextEdit(null)
            }
          }}
          style={{
            ...S.textInput,
            left: textEdit.x,
            top: textEdit.y,
            color: style.color,
            fontSize: textFontSize(style.width)
          }}
        />
      )}
      {!sel && <div style={S.hint}>拖拽框选 · 右键取消 · Esc 退出</div>}
      {showMag && hover && sampleRef.current && (
        <Magnifier
          hover={hover}
          bounds={bounds}
          sample={sampleRef.current}
          ratio={ratio}
          bitmapW={shot.bitmapW}
          bitmapH={shot.bitmapH}
          zoom={zoom}
          fmt={fmt}
        />
      )}
    </div>
  )
}

const MAG_SIZE = 120 // 放大镜显示区边长(px)
const MAG_OFFSET = 18 // 相对指针偏移

/**
 * 像素放大镜(§2.4):以 hover 处为中心,从采样 canvas 取一块像素放大绘制 + 中心十字,
 * 底部显示逻辑坐标 + 该像素颜色值(RGB/HEX)。跟指针,贴边翻侧避免出屏。
 */
function Magnifier(props: {
  hover: { x: number; y: number }
  bounds: { w: number; h: number }
  sample: HTMLCanvasElement
  ratio: { x: number; y: number }
  bitmapW: number
  bitmapH: number
  zoom: number
  fmt: ColorFormat
}): JSX.Element {
  const { hover, bounds, sample, ratio, bitmapW, bitmapH, zoom, fmt } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rgb, setRgb] = useState<[number, number, number] | null>(null)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const raw = logicalToPixel(hover.x, hover.y, ratio)
    const { px, py } = clampPixel(raw.px, raw.py, bitmapW, bitmapH)
    // 取样区:以 (px,py) 为中心的 srcPx×srcPx 物理像素,放大 zoom 倍铺满 MAG_SIZE。
    const srcPx = Math.max(1, Math.round(MAG_SIZE / zoom))
    const half = Math.floor(srcPx / 2)
    ctx.imageSmoothingEnabled = false // 保持像素块状(§2.4 像素级)
    ctx.clearRect(0, 0, MAG_SIZE, MAG_SIZE)
    ctx.drawImage(sample, px - half, py - half, srcPx, srcPx, 0, 0, MAG_SIZE, MAG_SIZE)
    // 中心十字
    ctx.strokeStyle = 'rgba(45,132,196,0.9)'
    ctx.lineWidth = 1
    const c = MAG_SIZE / 2
    ctx.strokeRect(c - zoom / 2, c - zoom / 2, zoom, zoom) // 高亮中心像素格
    // 取中心像素颜色
    const d = sample.getContext('2d')?.getImageData(px, py, 1, 1).data
    if (d) setRgb([d[0], d[1], d[2]])
  }, [hover.x, hover.y, sample, ratio.x, ratio.y, bitmapW, bitmapH, zoom])

  // 定位:默认在指针右下,贴右/下边则翻侧(§4.7 避让)。
  const boxW = MAG_SIZE + 2
  const boxH = MAG_SIZE + 34
  let left = hover.x + MAG_OFFSET
  let top = hover.y + MAG_OFFSET
  if (left + boxW > bounds.w) left = hover.x - MAG_OFFSET - boxW
  if (top + boxH > bounds.h) top = hover.y - MAG_OFFSET - boxH

  return (
    <div style={{ ...S.magBox, left, top }}>
      <canvas ref={canvasRef} width={MAG_SIZE} height={MAG_SIZE} style={S.magCanvas} />
      <div style={S.magInfo}>
        <div>
          ({Math.round(hover.x)}, {Math.round(hover.y)})
        </div>
        <div style={S.magColorRow}>
          {rgb && <span style={{ ...S.magSwatch, background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` }} />}
          <span>{rgb ? formatColor(rgb[0], rgb[1], rgb[2], fmt) : '—'}</span>
        </div>
        <div style={S.magKeys}>C 复制 · Shift 切格式 · 滚轮缩放</div>
      </div>
    </div>
  )
}

/** 选区外四块压暗(上/下/左/右),选区内不盖。 */
function DimAround({ sel }: { sel: Rect }): JSX.Element {
  const band = (s: React.CSSProperties): React.CSSProperties => ({
    position: 'absolute',
    background: 'rgba(0,0,0,0.45)',
    pointerEvents: 'none',
    ...s
  })
  return (
    <>
      <div style={band({ left: 0, top: 0, width: '100%', height: sel.y })} />
      <div style={band({ left: 0, top: sel.y + sel.h, width: '100%', bottom: 0 })} />
      <div style={band({ left: 0, top: sel.y, width: sel.x, height: sel.h })} />
      <div style={band({ left: sel.x + sel.w, top: sel.y, right: 0, height: sel.h })} />
    </>
  )
}

/** W×H 尺寸标签,贴选区左上外侧;贴顶时移入内侧(§4.7 避让)。 */
function SizeLabel({ sel }: { sel: Rect }): JSX.Element {
  const top = sel.y >= 22 ? sel.y - 22 : sel.y + 4
  return (
    <div style={{ ...S.sizeLabel, left: sel.x, top }}>
      {Math.round(sel.w)} × {Math.round(sel.h)}
    </div>
  )
}

const TOOLBAR_H = 32
const TOOLS: Array<{ t: ShotTool; icon: string; label: string }> = [
  { t: 'rect', icon: '▭', label: '矩形' },
  { t: 'ellipse', icon: '◯', label: '椭圆' },
  { t: 'arrow', icon: '↗', label: '箭头' },
  { t: 'line', icon: '／', label: '直线' },
  { t: 'pen', icon: '✎', label: '画笔' },
  { t: 'mosaic', icon: '▚', label: '马赛克' },
  { t: 'blur', icon: '◍', label: '模糊' },
  { t: 'text', icon: 'A', label: '文字' },
  { t: 'badge', icon: '①', label: '序号' }
]
const COLORS = ['#e23b3b', '#f59e0b', '#22c55e', '#2d84c4', '#7c3aed', '#111111', '#ffffff']

/** 工具条(§4.7):标注工具 + 颜色/粗细 + 撤销重做 + 输出。贴选区下外侧,不足翻上/浮内。 */
function Toolbar(props: {
  sel: Rect
  bounds: { w: number; h: number }
  hasPeer: boolean
  tool: ShotTool | null
  style: ShotStyle
  canUndo: boolean
  canRedo: boolean
  onTool: (t: ShotTool | null) => void
  onStyle: (s: ShotStyle) => void
  onUndo: () => void
  onRedo: () => void
  onClear: () => void
  onCopy: () => void
  onSave: () => void
  onSend: () => void
}): JSX.Element {
  const { sel, bounds, hasPeer, tool, style } = props
  const belowTop = sel.y + sel.h + 8
  const top =
    belowTop + TOOLBAR_H <= bounds.h
      ? belowTop
      : sel.y - TOOLBAR_H - 8 >= 0
        ? sel.y - TOOLBAR_H - 8
        : sel.y + sel.h - TOOLBAR_H - 8 // 内右下
  const right = Math.max(4, bounds.w - (sel.x + sel.w))
  return (
    // 阻止 pointerdown 冒泡到 root:否则点按钮会被当成"选区外点击"→ 清空选区(§4.7 / 记忆)
    <div
      style={{ ...S.toolbar, top, right }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {TOOLS.map(({ t, icon, label }) => (
        <button
          key={t}
          style={{ ...S.tbTool, ...(tool === t ? S.tbToolOn : {}) }}
          title={label}
          onClick={() => props.onTool(tool === t ? null : t)}
        >
          {icon}
        </button>
      ))}
      <div style={S.tbSep} />
      <div style={S.tbSwatches}>
        {COLORS.map((c) => (
          <button
            key={c}
            style={{
              ...S.tbSwatch,
              background: c,
              outline: style.color === c ? '2px solid #2d84c4' : '1px solid rgba(255,255,255,0.25)'
            }}
            onClick={() => props.onStyle({ ...style, color: c })}
          />
        ))}
      </div>
      <input
        type="range"
        min={1}
        max={6}
        value={style.width}
        onChange={(e) => props.onStyle({ ...style, width: Number(e.target.value) })}
        style={S.tbRange}
        title="粗细"
      />
      <div style={S.tbSep} />
      <button style={S.tbTool} disabled={!props.canUndo} onClick={props.onUndo} title="撤销">
        ↶
      </button>
      <button style={S.tbTool} disabled={!props.canRedo} onClick={props.onRedo} title="重做">
        ↷
      </button>
      <div style={S.tbSep} />
      <button style={S.tbTool} onClick={props.onCopy} title="复制到剪贴板">
        <CopyIcon size={15} />
      </button>
      <button style={S.tbTool} onClick={props.onSave} title="保存为文件">
        <SaveIcon size={15} />
      </button>
      <button
        style={{ ...S.tbTool, ...(hasPeer ? S.tbToolPrimary : S.tbToolDisabled) }}
        onClick={props.onSend}
        disabled={!hasPeer}
        title={hasPeer ? '发到当前聊天' : '先在主窗选择一个聊天对象'}
      >
        <SendIcon size={15} />
      </button>
    </div>
  )
}

const ANCHOR_POS: Record<Anchor, [number, number]> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5]
}
const CORNERS: Anchor[] = ['nw', 'ne', 'se', 'sw']

function Anchors({ sel, level }: { sel: Rect; level: 'all' | 'corners' }): JSX.Element {
  const list = level === 'all' ? (Object.keys(ANCHOR_POS) as Anchor[]) : CORNERS
  return (
    <>
      {list.map((a) => {
        const [fx, fy] = ANCHOR_POS[a]
        return (
          <div
            key={a}
            style={{
              ...S.anchor,
              left: sel.x + sel.w * fx - ANCHOR_SIZE / 2,
              top: sel.y + sel.h * fy - ANCHOR_SIZE / 2
            }}
          />
        )
      })}
    </>
  )
}

const HANDLE_TOL = 7
const ANCHOR_SIZE = 9

const S: Record<string, React.CSSProperties> = {
  mask: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.35)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'wait',
    userSelect: 'none'
  },
  root: { position: 'fixed', inset: 0, overflow: 'hidden', cursor: 'crosshair', userSelect: 'none' },
  bg: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' },
  dimFull: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', pointerEvents: 'none' },
  selBox: {
    position: 'absolute',
    border: '1px solid #2d84c4',
    boxSizing: 'border-box',
    pointerEvents: 'none'
  },
  anchor: {
    position: 'absolute',
    width: ANCHOR_SIZE,
    height: ANCHOR_SIZE,
    background: '#fff',
    border: '1px solid #2d84c4',
    borderRadius: 2,
    pointerEvents: 'none'
  },
  sizeLabel: {
    position: 'absolute',
    fontSize: 11,
    fontVariantNumeric: 'tabular-nums',
    color: '#fff',
    background: 'rgba(0,0,0,0.6)',
    padding: '1px 6px',
    borderRadius: 4,
    pointerEvents: 'none',
    whiteSpace: 'nowrap'
  },
  magBox: {
    position: 'absolute',
    background: 'rgba(20,20,22,0.9)',
    borderRadius: 6,
    padding: 1,
    pointerEvents: 'none',
    boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
    fontFamily: 'ui-monospace, Menlo, monospace'
  },
  magCanvas: {
    display: 'block',
    width: MAG_SIZE,
    height: MAG_SIZE,
    borderRadius: 4,
    imageRendering: 'pixelated'
  },
  magInfo: { color: '#e8e8ea', fontSize: 10.5, padding: '3px 5px 4px', lineHeight: 1.5 },
  magColorRow: { display: 'flex', alignItems: 'center', gap: 5 },
  magSwatch: { width: 10, height: 10, borderRadius: 2, border: '1px solid rgba(255,255,255,0.3)' },
  magKeys: { color: '#8a8d93', fontSize: 9, marginTop: 1 },
  toolbar: {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    gap: 1,
    padding: 3,
    background: 'rgba(28,28,30,0.95)',
    borderRadius: 8,
    boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
    pointerEvents: 'auto', // 按钮可点(root 是 crosshair 但工具条要交互)
    whiteSpace: 'nowrap', // 不折行:窄选区时工具条整体保持一行,靠定位不超出屏
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif'
  },
  tbTool: {
    flexShrink: 0,
    width: 24,
    height: 24,
    border: 'none',
    borderRadius: 5,
    fontSize: 13,
    cursor: 'pointer',
    background: 'transparent',
    color: '#d6d7da',
    display: 'grid',
    placeItems: 'center'
  },
  tbToolOn: { background: '#2d84c4', color: '#fff' },
  tbToolPrimary: { background: '#2d84c4', color: '#fff' },
  tbToolDisabled: { color: '#5f6167', cursor: 'not-allowed' },
  tbSep: { width: 1, height: 18, alignSelf: 'center', background: 'rgba(255,255,255,0.15)', margin: '0 3px', flexShrink: 0 },
  tbSwatches: { display: 'flex', alignItems: 'center', gap: 4, margin: '0 3px' },
  tbSwatch: { width: 11, height: 11, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 },
  tbRange: { width: 40, cursor: 'pointer', flexShrink: 0 },
  textInput: {
    position: 'absolute',
    width: 160,
    height: '1.4em',
    background: 'rgba(0,0,0,0.25)',
    border: '1px dashed rgba(45,132,196,0.9)',
    outline: 'none',
    resize: 'none',
    overflow: 'hidden',
    fontFamily: '-apple-system, "PingFang SC", sans-serif',
    lineHeight: 1.3,
    padding: '1px 3px',
    boxSizing: 'content-box',
    pointerEvents: 'auto',
    zIndex: 10
  },
  hint: {
    position: 'absolute',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    color: '#fff',
    fontSize: 13,
    padding: '6px 16px',
    borderRadius: 18,
    background: 'rgba(0,0,0,0.55)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
    pointerEvents: 'none'
  }
}

createRoot(document.getElementById('overlay-root')!).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>
)
