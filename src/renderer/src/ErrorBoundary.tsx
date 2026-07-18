import React from 'react'
import { useI18n } from './i18n'
import type { TKey } from '@shared/i18n/dict'

/**
 * 错误边界:捕获子树渲染/生命周期抛出的错误,显示兜底 UI 而非整页白屏。
 * 用法:把可能出错的局部(或整个 App)包进 <ErrorBoundary>。
 * 注意:React 错误边界**不**捕获事件处理器、异步(setTimeout/Promise)、SSR 里的错误。
 *
 * i18n:label 传翻译 key(如 'sidebar.boundaryChat');兜底 UI 文案由 <BoundaryFallback>
 * 经 useI18n 取。ErrorBoundary 必须置于 <I18nProvider> 内(否则 fallback 取不到 context)。
 */
interface Props {
  children: React.ReactNode
  /** 兜底 UI 的标签翻译 key(区分是哪块崩了);不传则用通用兜底文案 */
  labelKey?: TKey
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
    console.error(`[ErrorBoundary${this.props.labelKey ? ` ${this.props.labelKey}` : ''}]`, error, info)
  }

  private reset = (): void => this.setState({ error: null })

  render(): React.ReactNode {
    if (this.state.error) {
      return <BoundaryFallback labelKey={this.props.labelKey} message={this.state.error.message} onReset={this.reset} />
    }
    return this.props.children
  }
}

/** 兜底 UI(函数组件,便于用 useI18n)。 */
function BoundaryFallback(props: { labelKey?: TKey; message: string; onReset: () => void }): JSX.Element {
  const { t } = useI18n()
  const label = props.labelKey ? t(props.labelKey) : t('error.boundaryFallback')
  return (
    <div style={S.box}>
      <div style={S.title}>{t('error.boundarySuffix', { label })}</div>
      <div style={S.msg}>{props.message}</div>
      <button style={S.btn} onClick={props.onReset}>
        {t('error.retry')}
      </button>
    </div>
  )
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
