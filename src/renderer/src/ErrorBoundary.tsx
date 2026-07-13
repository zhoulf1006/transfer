import React from 'react'

/**
 * 错误边界:捕获子树渲染/生命周期抛出的错误,显示兜底 UI 而非整页白屏。
 * 用法:把可能出错的局部(或整个 App)包进 <ErrorBoundary>。
 * 注意:React 错误边界**不**捕获事件处理器、异步(setTimeout/Promise)、SSR 里的错误。
 */
interface Props {
  children: React.ReactNode
  /** 兜底 UI 的标签(区分是哪块崩了) */
  label?: string
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ''}]`, error, info)
  }

  private reset = (): void => this.setState({ error: null })

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={S.box}>
          <div style={S.title}>{this.props.label ?? '这里'}出错了</div>
          <div style={S.msg}>{this.state.error.message}</div>
          <button style={S.btn} onClick={this.reset}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const S: Record<string, React.CSSProperties> = {
  box: {
    padding: 20,
    margin: 12,
    borderRadius: 10,
    background: 'var(--card)',
    border: '1px solid var(--line)',
    color: 'var(--ink)',
    fontSize: 13,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    alignItems: 'flex-start'
  },
  title: { fontWeight: 600 },
  msg: { color: 'var(--muted)', fontSize: 12, wordBreak: 'break-word' },
  btn: {
    padding: '5px 14px',
    border: '1px solid var(--line-strong)',
    borderRadius: 7,
    background: 'var(--accent-soft)',
    color: 'var(--accent)',
    cursor: 'pointer',
    fontSize: 12.5
  }
}
