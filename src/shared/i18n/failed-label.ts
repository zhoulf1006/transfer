// failed 消息的 errorReason → 文案键映射(纯逻辑,便于单测)。

import type { TKey } from './dict'
import type { ErrorReason } from '../message-state'

/**
 * 全覆盖表:ErrorReason 新增成员时此处漏填即编译报错,不会静默落到通用文案。
 * 映射到 chat.failed.default 的是**显式选择**走通用文案,不是遗漏。
 */
const FAILED_KEY: Record<ErrorReason, TKey> = {
  busy: 'chat.failed.busy',
  offline: 'chat.failed.offline',
  timeout: 'chat.failed.timeout',
  refused: 'chat.failed.refused',
  'cert-mismatch': 'chat.failed.certMismatch',
  // 以下两条是接收方本机写盘/校验失败,文案不写"对方"
  enospc: 'chat.failed.enospc',
  sha256: 'chat.failed.sha256',
  network: 'chat.failed.network'
}

/**
 * reason 为 null(失败但未归类)走通用文案。
 * ⚠️ `?? ` 不是多余的:DB 的 error_reason 是无约束 TEXT 列,rowToMessage 用 `as ErrorReason`
 * 强转(db/messages.ts),联合外的值能真的到达这里(如旧版读到新版写入的 reason)。
 * 类型上看不出来,但少了这层兜底就会返回 undefined,让状态文字渲染成空白。
 */
export function failedLabelKey(reason: ErrorReason | null): TKey {
  if (!reason) return 'chat.failed.default'
  return FAILED_KEY[reason] ?? 'chat.failed.default'
}
