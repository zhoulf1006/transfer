// 未读消息判定(纯逻辑,便于单测)。见 docs/unread-notification.md。
//
// 门控:一条到达的消息是否应计入未读(并触发提醒)。
// 规则:只对**收到的新消息**计未读,且当"用户正看着这条消息所属的会话且窗口聚焦"时不计。

export interface UnreadContext {
  /** 消息方向;只有 'recv'(收到的)才可能计未读 */
  direction: 'sent' | 'recv'
  /** 是否新消息(首次入库)。状态更新(如文件 done、发送态)不计 */
  isNew: boolean
  /** 主窗当前是否聚焦 */
  windowFocused: boolean
  /** 当前视图('chat' 才可能"正在看会话") */
  view: 'chat' | 'downloads'
  /** 当前选中的会话对端 fingerprint(null=未选) */
  currentPeer: string | null
  /** 该消息所属对端 fingerprint */
  msgPeer: string
}

/**
 * 是否把这条消息计入未读(并据此提醒)。
 * true 的充要条件:收到的 && 新消息 && 不是"聚焦且正看着该会话"。
 */
export function shouldCountUnread(ctx: UnreadContext): boolean {
  if (ctx.direction !== 'recv') return false
  if (!ctx.isNew) return false
  // 用户正盯着这条消息所属会话(聚焦 + chat 视图 + 选中的就是该 peer)→ 视为已读,不计
  const activelyViewing =
    ctx.windowFocused && ctx.view === 'chat' && ctx.currentPeer === ctx.msgPeer
  return !activelyViewing
}
