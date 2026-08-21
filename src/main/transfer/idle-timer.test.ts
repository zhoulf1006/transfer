import { test, expect, describe, vi, afterEach } from 'vitest'
import { createIdleTimer } from './idle-timer'

// 用假时钟:真等 45 秒既慢又不确定,而这里要验的是"多久没动静才算断",与真实时间无关。
afterEach(() => {
  vi.useRealTimers()
})

describe('createIdleTimer', () => {
  test('持续 touch 就不触发 —— 总时长远超阈值也不触发', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createIdleTimer(1000, onIdle)

    // 每 800ms 动一次,连续 20 次 = 16 秒,是阈值的 16 倍
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(800)
      t.touch()
    }

    expect(onIdle, '有活动就不该判定为断开,不论传了多久').not.toHaveBeenCalled()
    t.clear()
  })

  test('停止 touch 超过阈值后触发,且只触发一次', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createIdleTimer(1000, onIdle)

    t.touch()
    vi.advanceTimersByTime(999)
    expect(onIdle, '未到阈值不得触发').not.toHaveBeenCalled()

    vi.advanceTimersByTime(2)
    expect(onIdle).toHaveBeenCalledTimes(1)

    // 再等很久也不该重复触发(重复触发会对同一个请求 destroy 多次)
    vi.advanceTimersByTime(10_000)
    expect(onIdle, '只应触发一次').toHaveBeenCalledTimes(1)
    t.clear()
  })

  test('clear 之后不再触发', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createIdleTimer(1000, onIdle)

    t.touch()
    t.clear()
    vi.advanceTimersByTime(10_000)

    expect(onIdle, 'clear 之后必须彻底停掉 —— 否则响应已到达却仍会 destroy 连接').not.toHaveBeenCalled()
  })

  test('创建后未 touch 也开始计时(防"一个字节都没发出去"的挂起)', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const t = createIdleTimer(1000, onIdle)

    vi.advanceTimersByTime(1001)

    expect(onIdle, '建好就该开始计时,不能等到第一次 touch').toHaveBeenCalledTimes(1)
    t.clear()
  })
})
