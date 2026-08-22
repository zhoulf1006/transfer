import { test, expect, describe } from 'vitest'
import { fmtDuration, fmtSpeed, nextSpeed } from './transfer-stats'

describe('fmtDuration — 统一 h/m/s,不随语言变', () => {
  test('不足 1 分只写秒', () => {
    expect(fmtDuration(18_000)).toBe('18s')
    expect(fmtDuration(59_000)).toBe('59s')
  })

  test('满 1 分写 m+s,不写 h', () => {
    expect(fmtDuration(60_000)).toBe('1m0s')
    expect(fmtDuration(245_000)).toBe('4m5s')
  })

  test('满 1 时写 h+m+s', () => {
    expect(fmtDuration(5_025_000)).toBe('1h23m45s')
    expect(fmtDuration(3_600_000)).toBe('1h0m0s')
  })

  test('不足 1 秒向上取整成 1s —— 显示 0s 会让人以为根本没传', () => {
    expect(fmtDuration(400)).toBe('1s')
    expect(fmtDuration(1)).toBe('1s')
  })

  test('拿不到时长时返回 null,由调用方整个不渲染', () => {
    expect(fmtDuration(null)).toBeNull()
  })

  test('负数与非有限值一律当拿不到 —— 时钟回拨算出的负时长不能显示成 -3s', () => {
    expect(fmtDuration(-1000)).toBeNull()
    expect(fmtDuration(Number.NaN)).toBeNull()
    expect(fmtDuration(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('fmtSpeed', () => {
  test('小于 1MB/s 用 KB/s,取整', () => {
    expect(fmtSpeed(348_160)).toBe('340 KB/s')
    expect(fmtSpeed(1024)).toBe('1 KB/s')
  })

  test('1MB/s 以上用 MB/s;小于 100 保留一位小数,100 以上取整(宽度不失控)', () => {
    expect(fmtSpeed(12.3 * 1024 * 1024)).toBe('12.3 MB/s')
    expect(fmtSpeed(118 * 1024 * 1024)).toBe('118 MB/s')
  })

  test('极慢时用 B/s,不显示 0 KB/s', () => {
    expect(fmtSpeed(500)).toBe('500 B/s')
  })

  test('算不出速度时返回 null,该位留空', () => {
    expect(fmtSpeed(null)).toBeNull()
    expect(fmtSpeed(Number.NaN)).toBeNull()
    expect(fmtSpeed(-1)).toBeNull()
  })
})

describe('nextSpeed — 按进度增量算并平滑', () => {
  test('第一帧算不出速度:没有可比的前一帧', () => {
    expect(nextSpeed(undefined, { sent: 1024, at: 1000 })).toBeNull()
  })

  test('稳定速率下收敛到真实值', () => {
    // 每 100ms 传 1MB → 10MB/s
    const MB = 1024 * 1024
    let prev = { sent: 0, at: 0, bps: null as number | null }
    let bps: number | null = null
    for (let i = 1; i <= 40; i++) {
      const cur = { sent: i * MB, at: i * 100 }
      bps = nextSpeed(prev, cur)
      prev = { ...cur, bps }
    }
    expect(bps).not.toBeNull()
    expect(bps! / MB, '连续稳定投喂后应收敛到 10MB/s 附近').toBeCloseTo(10, 0)
  })

  test('平滑真的在起作用:单帧尖峰不会让读数跳到尖峰值', () => {
    const MB = 1024 * 1024
    const prev = { sent: 10 * MB, at: 1000, bps: 10 * MB }
    // 这一帧突然来了 10 倍的量
    const spiked = nextSpeed(prev, { sent: 20 * MB, at: 1100 })!
    const instant = (10 * MB) / 0.1 // 100MB/s

    expect(spiked, '不能直接等于瞬时值').toBeLessThan(instant)
    expect(spiked, '也不能纹丝不动 —— 那是没在跟随').toBeGreaterThan(prev.bps)
  })

  test('同一毫秒内的两帧不更新读数:除以 0 会得到 Infinity', () => {
    const prev = { sent: 1024, at: 5000, bps: 2048 }
    expect(nextSpeed(prev, { sent: 4096, at: 5000 })).toBe(2048)
  })

  test('时钟回拨:时间倒流的帧一律忽略,保持上次读数', () => {
    const prev = { sent: 1024, at: 5000, bps: 2048 }
    expect(nextSpeed(prev, { sent: 4096, at: 4000 })).toBe(2048)
  })

  test('字节数倒退(不该发生但要防)同样忽略,不产生负速度', () => {
    const prev = { sent: 4096, at: 5000, bps: 2048 }
    expect(nextSpeed(prev, { sent: 1024, at: 6000 })).toBe(2048)
  })
})
