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
  const [sel, setSel] = useState<Rect | null>(null)
  const drag = useRef<DragMode>(null)
  const rootRef = useRef<HTMLDivElement>(null)

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
    const d = drag.current
    if (!d) return
    const p = pt(e)
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

  return (
    <div
      ref={rootRef}
      style={S.root}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
    >
      <img src={shot.dataUrl} style={S.bg} draggable={false} alt="" />
      {/* 四块压暗遮住选区外(选区内保持原图明亮);无选区时整屏压暗 */}
      {sel && valid ? <DimAround sel={sel} /> : <div style={S.dimFull} />}
      {sel && valid && (
        <>
          <div style={{ ...S.selBox, left: sel.x, top: sel.y, width: sel.w, height: sel.h }} />
          <SizeLabel sel={sel} />
          {level !== 'none' && <Anchors sel={sel} level={level} />}
        </>
      )}
      {!sel && <div style={S.hint}>拖拽框选 · 右键取消 · Esc 退出</div>}
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
