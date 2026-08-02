// failed 消息的 errorReason → 文案键映射。
//
// 期望值为手写字面量(来自 dict.ts 的既有键与产品选择),不从被测模块反算。

import { test, expect, describe } from 'vitest'
import { failedLabelKey } from './failed-label'
import type { ErrorReason } from '../message'

describe('failedLabelKey', () => {
  const EXPECTED: Record<ErrorReason, string> = {
    busy: 'chat.failed.busy',
    offline: 'chat.failed.offline',
    timeout: 'chat.failed.timeout',
    refused: 'chat.failed.refused',
    'cert-mismatch': 'chat.failed.certMismatch',
    enospc: 'chat.failed.enospc',
    sha256: 'chat.failed.sha256',
    network: 'chat.failed.network',
    directory: 'chat.failed.directory'
  }

  for (const [reason, key] of Object.entries(EXPECTED)) {
    test(`${reason} → ${key}`, () => {
      expect(failedLabelKey(reason as ErrorReason)).toBe(key)
    })
  }

  test('null(失败但未归类)→ 通用文案', () => {
    expect(failedLabelKey(null)).toBe('chat.failed.default')
  })

  // 回归:DB 的 error_reason 是无约束 TEXT 列,rowToMessage 直接 `as ErrorReason` 强转
  // (db/messages.ts),联合外的值确实能到达这里——例如新版写入的 reason 被旧版读到。
  // 早先版本用 switch + default 兜住;改成查表后若不兜底,会返回 undefined,
  // 最终让整条消息的状态文字渲染成空白。
  test('联合外的历史值 → 回落通用文案,不返回 undefined', () => {
    expect(failedLabelKey('some-future-reason' as ErrorReason)).toBe('chat.failed.default')
  })
})
