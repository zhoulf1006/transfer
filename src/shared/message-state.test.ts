// 消息状态派生谓词单测。
//
// 期望值全部手写字面量,来自改造前的既有实现(chat-service.ts 的 TERMINAL、
// App.tsx 的 canRespond/transferring),不从被测模块导入常量反算——
// 这些断言的作用正是钉住"重构没改变行为"。
//
// ── 覆盖缺口(诚实标注,勿当已覆盖)──
// 以下两处调用点在 renderer,本仓库测不到:vitest 的 include 只匹配 `src/**/*.test.ts`
// (不含 .tsx)且 environment 为 node、无 jsdom,渲染组件没有测试宿主。
//   1. App.tsx statusLabel 的 never 穷尽守卫——新增状态时的**编译**报错已实测验证
//      (临时加 'paused' 跑 tsc 确认报错),但其**运行时**行为(联合外的值原样返回字符串)无自动化覆盖。
//   2. App.tsx 收到终态消息时清理进度条 setProgress——无覆盖。
// 补测条件:renderer 引入 jsdom + 组件测试宿主,或把这两处判断继续下沉到 shared 纯函数。
// chat-service 侧的 isTerminal 调用点有行为覆盖(chat-service.test.ts「失败后同一 fileId 重试(2-C)」)。

import { test, expect, describe } from 'vitest'
import { isTerminal, isTransferring, canRespond } from './message-state'
import type { Direction, MessageStatus } from './message-state'

/** 七个状态,手写枚举(与 MessageStatus 联合成员一一对应) */
const STATUSES: readonly MessageStatus[] = [
  'pending',
  'accepted',
  'rejected',
  'sent',
  'done',
  'failed',
  'expired'
]

describe('isTerminal', () => {
  // 改造前:chat-service.ts 的 TERMINAL = new Set(['done','failed','rejected','expired'])
  const EXPECTED: Record<MessageStatus, boolean> = {
    pending: false,
    accepted: false,
    sent: false,
    done: true,
    failed: true,
    rejected: true,
    expired: true
  }

  for (const s of STATUSES) {
    test(`${s} → ${EXPECTED[s]}`, () => {
      expect(isTerminal(s)).toBe(EXPECTED[s])
    })
  }

  test('终态集合与改造前 chat-service 的字面量完全一致', () => {
    expect(STATUSES.filter(isTerminal).sort()).toEqual(
      ['done', 'failed', 'rejected', 'expired'].sort()
    )
  })
})

describe('isTransferring', () => {
  // 改造前:App.tsx 的 transferring = status === 'pending' || status === 'accepted'
  const EXPECTED: Record<MessageStatus, boolean> = {
    pending: true,
    accepted: true,
    sent: false,
    done: false,
    failed: false,
    rejected: false,
    expired: false
  }

  for (const s of STATUSES) {
    test(`${s} → ${EXPECTED[s]}`, () => {
      expect(isTransferring(s)).toBe(EXPECTED[s])
    })
  }
})

describe('canRespond', () => {
  // 改造前:App.tsx 的 canRespond = direction === 'recv' && status === 'pending'
  // 十四种组合逐条列出,不用"recv 且 pending"的规则反算(那是实现同款算法)。
  const CASES: ReadonlyArray<[Direction, MessageStatus, boolean]> = [
    ['recv', 'pending', true],
    ['recv', 'accepted', false],
    ['recv', 'rejected', false],
    ['recv', 'sent', false],
    ['recv', 'done', false],
    ['recv', 'failed', false],
    ['recv', 'expired', false],
    ['sent', 'pending', false],
    ['sent', 'accepted', false],
    ['sent', 'rejected', false],
    ['sent', 'sent', false],
    ['sent', 'done', false],
    ['sent', 'failed', false],
    ['sent', 'expired', false]
  ]

  for (const [direction, status, expected] of CASES) {
    test(`${direction} + ${status} → ${expected}`, () => {
      expect(canRespond({ direction, status })).toBe(expected)
    })
  }
})

describe('联合外的历史值', () => {
  // DB 的 status 是无约束 TEXT 列,rowToMessage 直接 `as MessageStatus` 强转
  // (db/messages.ts),联合外的值确实能到达这里——例如新版写入的状态被旧版读到。
  // 改造前是 Set.has / === 比较,一律得 false;查表实现必须收敛出同样的 false,
  // 不能漏出 undefined。
  const alien = 'some-future-status' as MessageStatus

  test('isTerminal → false(不是 undefined)', () => {
    expect(isTerminal(alien)).toBe(false)
  })

  test('isTransferring → false(不是 undefined)', () => {
    expect(isTransferring(alien)).toBe(false)
  })

  test('canRespond → false(不是 undefined)', () => {
    expect(canRespond({ direction: 'recv', status: alien })).toBe(false)
  })
})

