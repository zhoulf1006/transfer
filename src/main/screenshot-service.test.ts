import { describe, it, expect } from 'vitest'
import { shouldStartSession, type ShotState } from './screenshot-service'

// F1 守卫(§4.2):仅 idle 且无抓屏 in-flight 才启动新截图会话。
describe('shouldStartSession — F1 守卫', () => {
  it('idle 且未抓屏 → 启动', () => {
    expect(shouldStartSession('idle', false)).toBe(true)
  })

  it('idle 但抓屏 in-flight → 忽略(防并发抓屏)', () => {
    // 极端时序:上次 F1 已进 idle 但抓屏 promise 未结束,capturing 仍 true。
    expect(shouldStartSession('idle', true)).toBe(false)
  })

  it.each<ShotState>(['capturing', 'selecting', 'editing'])(
    '非 idle 态(%s)→ 忽略(editing 中按 F1 也忽略)',
    (state) => {
      expect(shouldStartSession(state, false)).toBe(false)
      expect(shouldStartSession(state, true)).toBe(false)
    }
  )
})
