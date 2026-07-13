import { describe, it, expect } from 'vitest'
import { computeRatios } from './screenshot-geometry'

// 两轴缩放比(§3.1/§4.5):位图物理尺寸 / display 逻辑尺寸,X/Y 各自算。
describe('computeRatios — 两轴缩放比', () => {
  it('2x Retina 等比', () => {
    expect(computeRatios({ width: 5120, height: 2880 }, { width: 2560, height: 1440 })).toEqual({
      x: 2,
      y: 2
    })
  })

  it('1x 非缩放', () => {
    expect(computeRatios({ width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toEqual({
      x: 1,
      y: 1
    })
  })

  it('Windows 150% 缩放', () => {
    expect(computeRatios({ width: 2880, height: 1620 }, { width: 1920, height: 1080 })).toEqual({
      x: 1.5,
      y: 1.5
    })
  })

  it('两轴非等比(系统对 W/H 各自取整)→ X/Y 不同', () => {
    // 位图 W/H 各自取整后比例可能略不等,证明不能用单一 ratio。
    const r = computeRatios({ width: 2561, height: 1440 }, { width: 2560, height: 1440 })
    expect(r.x).not.toBe(r.y)
    expect(r.x).toBeCloseTo(1.00039, 4)
    expect(r.y).toBe(1)
  })
})
