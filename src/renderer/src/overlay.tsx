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

/**
 * 截图遮罩层(见 docs/screenshot-feature §4.1)。
 *
 * 阶段3:手动框选 + 内亮外暗 + W×H + 拖锚点/拖整块 + 方向键微调 + 右键重选 + 锚点隐藏。
 * 几何全走 @shared/screenshot-selection 纯函数。放大镜/标注在后续阶段。
 */
function Overlay(): JSX.Element {
  const [shot, setShot] = useState<ShotSource | null>(null)

  useEffect(() => {
    const unsub = window.transfer.shot.onShow(() => {
      window.transfer.shot.getShot().then((s) => setShot(s))
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.transfer.shot.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      unsub()
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

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button === 2) return // 右键交给 contextmenu 处理(重选)
    const p = pt(e)
    rootRef.current?.setPointerCapture(e.pointerId)
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
    setHover(p) // 放大镜跟指针(任何时候)
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
    // 框选结束若太小视为无效 → 清空(回到未选区态)
    if (drag.current?.kind === 'creating' && sel && !isValidSelection(sel)) setSel(null)
    drag.current = null
  }

  // 右键:有选区则重选(清空),无选区则取消会话(§2.3)
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if (sel) setSel(null)
    else window.transfer.shot.cancel()
  }

  // 方向键像素微调(§2.3):无修饰=移动,Ctrl=扩,Shift=缩
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!sel) return
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
  }, [sel, bounds.w, bounds.h])

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
   * 导出选区为 PNG(§4.4 导出):独立离屏 canvas 按物理像素尺寸裁背景。
   * 阶段5 无标注,只裁底图;标注合成在阶段6 叠加。
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
          <div style={{ ...S.selBox, left: sel.x, top: sel.y, width: sel.w, height: sel.h }} />
          <SizeLabel sel={sel} />
          {level !== 'none' && <Anchors sel={sel} level={level} />}
          <Toolbar
            sel={sel}
            bounds={bounds}
            hasPeer={shot.hasActivePeer}
            onCopy={doCopy}
            onSave={doSave}
            onSend={doSend}
          />
        </>
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

const TOOLBAR_H = 40
/** 输出工具条(§4.7):贴选区下外侧,下方不足翻上方,再不足浮内右下。 */
function Toolbar(props: {
  sel: Rect
  bounds: { w: number; h: number }
  hasPeer: boolean
  onCopy: () => void
  onSave: () => void
  onSend: () => void
}): JSX.Element {
  const { sel, bounds, hasPeer, onCopy, onSave, onSend } = props
  const belowTop = sel.y + sel.h + 8
  const top =
    belowTop + TOOLBAR_H <= bounds.h
      ? belowTop
      : sel.y - TOOLBAR_H - 8 >= 0
        ? sel.y - TOOLBAR_H - 8
        : sel.y + sel.h - TOOLBAR_H - 8 // 内右下
  const right = Math.max(4, bounds.w - (sel.x + sel.w))
  return (
    // 阻止 pointerdown 冒泡到 root:否则点按钮会被当成"选区外点击"→ 清空选区(§4.7)
    <div
      style={{ ...S.toolbar, top, right }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <button style={S.tbBtn} onClick={onCopy}>
        复制
      </button>
      <button style={S.tbBtn} onClick={onSave}>
        保存
      </button>
      <button
        style={{ ...S.tbBtn, ...S.tbPrimary, ...(hasPeer ? {} : S.tbDisabled) }}
        onClick={onSend}
        disabled={!hasPeer}
        title={hasPeer ? '发到当前聊天' : '先在主窗选择一个聊天对象'}
      >
        发聊天
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
    gap: 6,
    padding: 5,
    background: 'rgba(28,28,30,0.95)',
    borderRadius: 8,
    boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
    pointerEvents: 'auto', // 按钮可点(root 是 crosshair 但工具条要交互)
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif'
  },
  tbBtn: {
    border: 'none',
    borderRadius: 5,
    padding: '5px 12px',
    fontSize: 12,
    cursor: 'pointer',
    background: 'rgba(255,255,255,0.12)',
    color: '#eaeaec'
  },
  tbPrimary: { background: '#2d84c4', color: '#fff' },
  tbDisabled: { background: 'rgba(255,255,255,0.06)', color: '#6a6d73', cursor: 'not-allowed' },
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
