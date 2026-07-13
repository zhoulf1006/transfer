import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ShotSource } from '@shared/ipc'

/**
 * 截图遮罩层(见 docs/screenshot-feature §4.1)。
 *
 * 阶段2:进会话 → getShot 拉背景 → 底图层渲染(物理像素 1:1,不套 dpr,§3.3)+ 就绪门控。
 * 框选 / 放大镜 / 标注在后续阶段接入。
 */
function Overlay(): JSX.Element {
  const [shot, setShot] = useState<ShotSource | null>(null)

  useEffect(() => {
    // main 通知进会话(带 shotId)→ 拉背景。shotId 作 key 让下层强制重挂复位(§4.7)。
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

  // 就绪门控(§4.5):背景未到达前不可交互,只显示等待态。
  if (!shot) {
    return (
      <div style={S.mask}>
        <div style={S.hint}>正在截图…</div>
      </div>
    )
  }

  return <Session key={shot.shotId} shot={shot} />
}

/** 一次截图会话(shotId 变 → 整体重挂,天然复位)。 */
function Session({ shot }: { shot: ShotSource }): JSX.Element {
  return (
    <div style={S.root}>
      {/* 底图层:物理像素位图,CSS 缩回逻辑尺寸铺满遮罩,不进 canvas、不套 dpr(§3.3 blocker#5) */}
      <img src={shot.dataUrl} style={S.bg} draggable={false} alt="" />
      {/* 未框选:全屏压暗(框选层在阶段3叠加) */}
      <div style={S.dim} />
      <div style={S.hint}>拖拽框选 · Esc 取消(框选在下一阶段)</div>
    </div>
  )
}

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
  bg: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    // 物理位图铺满遮罩(逻辑尺寸):CSS 自动缩放,浏览器按 dpr 清晰渲染,不需手动 dpr 处理
    display: 'block',
    pointerEvents: 'none'
  },
  dim: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', pointerEvents: 'none' },
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
