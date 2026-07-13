import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * 截图遮罩层(见 docs/screenshot-feature §4.1)。
 *
 * 本阶段(骨架)只是一个全屏压暗层 + 提示 + Esc 取消,验证:
 * 多入口构建、遮罩窗弹出/铺满、preload shot 分组、Esc→main hide 回 idle。
 * 抓屏背景 / 框选 / 标注在后续阶段接入。
 */
function Overlay(): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.transfer.shot.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div style={S.mask}>
      <div style={S.hint}>截图骨架 · 按 Esc 取消</div>
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
    cursor: 'crosshair',
    userSelect: 'none'
  },
  hint: {
    color: '#fff',
    fontSize: 14,
    padding: '8px 18px',
    borderRadius: 20,
    background: 'rgba(0,0,0,0.5)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif'
  }
}

createRoot(document.getElementById('overlay-root')!).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>
)
