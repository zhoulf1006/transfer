import { describe, it, expect } from 'vitest'
import { computeRatios, cropRect } from './screenshot-geometry'

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

describe('cropRect — 逻辑选区→物理裁剪矩形(角点取整+clamp)', () => {
  const bmp = { width: 2560, height: 1440 } // 2x 屏,逻辑 1280×720

  it('2x 居中选区', () => {
    expect(cropRect({ x: 100, y: 100, w: 50, h: 50 }, { x: 2, y: 2 }, bmp)).toEqual({
      sx: 200,
      sy: 200,
      sw: 100,
      sh: 100
    })
  })

  it('贴右下边:sx+sw 不越界(角点作差,不逐边 round)', () => {
    // 逻辑选区一直到右下角 (1280,720)
    const r = cropRect({ x: 1230, y: 670, w: 50, h: 50 }, { x: 2, y: 2 }, bmp)
    expect(r.sx + r.sw).toBeLessThanOrEqual(bmp.width)
    expect(r.sy + r.sh).toBeLessThanOrEqual(bmp.height)
    expect(r).toEqual({ sx: 2460, sy: 1340, sw: 100, sh: 100 })
  })

  it('非整数 ratio 贴边不越界(1.9996 类偏差)', () => {
    const b2 = { width: 2559, height: 1440 }
    const r = cropRect({ x: 1230, y: 670, w: 50, h: 50 }, { x: 2559 / 1280, y: 2 }, b2)
    expect(r.sx + r.sw).toBeLessThanOrEqual(b2.width)
  })

  it('两轴非等比各用各的 ratio', () => {
    expect(cropRect({ x: 100, y: 100, w: 100, h: 100 }, { x: 1.5, y: 2 }, bmp)).toEqual({
      sx: 150,
      sy: 200,
      sw: 150,
      sh: 200
    })
  })
})
