// 消息状态词汇 + 状态派生判断(main 与 renderer 共享的唯一数据源)。
//
// 为什么在 shared:状态枚举原本在 main/db/messages.ts 与 shared/ipc.ts 各声明一份,
// 二者之间只有 preload 处的 any 断言(ipcRenderer.invoke 返回 any),编译器从不校验一致性。
// 新增状态时只改一侧不会报错,renderer 的派生判断静默漏改。
//
// 为什么派生判断用 Record<MessageStatus, boolean> 而不是 Set / ||:
// Set.has() 和 === 比较都是**偏函数**——对未知成员一律返回 false,新增状态照样编译通过。
// 全覆盖 Record 是**全函数**:漏填一个成员 tsc 直接报错,把"静默漏改"变成"编译不过"。
// 只有集合归属判断(终态/传输中/待用户决定)需要这层保护;单状态比较(如 === 'done')
// 不需要——新增状态不会改变它的答案。

export type MessageType = 'text' | 'file'
export type Direction = 'sent' | 'recv'

export type MessageStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'sent'
  | 'done'
  | 'failed'
  | 'expired'

export type ErrorReason =
  | 'busy'
  | 'enospc'
  | 'sha256'
  | 'network'
  | 'timeout'
  | 'refused'
  | 'cert-mismatch'
  | 'offline'

/** 终态:传输已结束,不会再有进度帧(进度节流状态与进度条都在此清理) */
const TERMINAL: Record<MessageStatus, boolean> = {
  pending: false,
  accepted: false,
  sent: false,
  done: true,
  failed: true,
  rejected: true,
  expired: true
}

/** 传输中:该显示百分比进度条的状态 */
const TRANSFERRING: Record<MessageStatus, boolean> = {
  pending: true,
  accepted: true,
  sent: false,
  done: false,
  failed: false,
  rejected: false,
  expired: false
}

/** 等待用户决定:收件方需要点接收/拒绝的状态 */
const AWAITING_DECISION: Record<MessageStatus, boolean> = {
  pending: true,
  accepted: false,
  sent: false,
  done: false,
  failed: false,
  rejected: false,
  expired: false
}

// `=== true` 不是多余的:DB 的 status 是无约束 TEXT 列,rowToMessage 用 `as MessageStatus`
// 强转(db/messages.ts),联合外的值能真的到达这里(如旧版读到新版写入的状态)。
// 查表会得到 undefined,不收敛成 false 就会让返回类型说谎。
// 落在联合外时一律答"否",与改造前 Set.has / === 比较的行为一致。

export function isTerminal(status: MessageStatus): boolean {
  return TERMINAL[status] === true
}

export function isTransferring(status: MessageStatus): boolean {
  return TRANSFERRING[status] === true
}

/** 收件方且等待决定时,才允许响应(接收/拒绝)。发件方永远不能响应自己的消息。 */
export function canRespond(m: { direction: Direction; status: MessageStatus }): boolean {
  return m.direction === 'recv' && AWAITING_DECISION[m.status] === true
}
