import { test, expect, describe } from 'vitest'
import { minutesToKeepMs, OFFLINE_KEEP_PRESETS, OFFLINE_KEEP_NEVER } from './offline-keep'

describe('minutesToKeepMs', () => {
  test('0(从不)→ Infinity', () => {
    expect(minutesToKeepMs(0)).toBe(Infinity)
    expect(minutesToKeepMs(OFFLINE_KEEP_NEVER)).toBe(Infinity)
  })

  test('正常分钟 → 毫秒', () => {
    expect(minutesToKeepMs(10)).toBe(10 * 60_000)
    expect(minutesToKeepMs(60)).toBe(3_600_000)
    expect(minutesToKeepMs(1440)).toBe(1440 * 60_000)
  })

  test('非法输入(NaN/负数/undefined)→ 默认 60min,不返回 NaN/Infinity', () => {
    // 防御 C1:非法值绝不能静默变成"永不删除"(NaN 也让 >= 恒 false)
    expect(minutesToKeepMs(NaN)).toBe(60 * 60_000)
    expect(minutesToKeepMs(-5)).toBe(60 * 60_000)
    expect(minutesToKeepMs(undefined as unknown as number)).toBe(60 * 60_000)
    expect(minutesToKeepMs(1.5)).toBe(60 * 60_000)
  })
})

describe('OFFLINE_KEEP_PRESETS', () => {
  test('含需求约定的 7 个预设值(分钟),0 代表从不', () => {
    const mins = OFFLINE_KEEP_PRESETS.map((p) => p.minutes)
    expect(mins).toEqual([10, 30, 60, 360, 720, 1440, 0])
  })
})
