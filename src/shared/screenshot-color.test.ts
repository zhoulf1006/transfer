import { describe, it, expect } from 'vitest'
import {
  logicalToPixel,
  clampPixel,
  formatColor,
  clampZoom
} from './screenshot-color'

describe('logicalToPixel — 逻辑→物理像素(单一 ratio 真源)', () => {
  it('2x:逻辑 (100,50) → 物理 (200,100)', () => {
    expect(logicalToPixel(100, 50, { x: 2, y: 2 })).toEqual({ px: 200, py: 100 })
  })
  it('非等比两轴各用各的', () => {
    expect(logicalToPixel(100, 100, { x: 1.5, y: 2 })).toEqual({ px: 150, py: 200 })
  })
  it('floor 取整(命中该像素)', () => {
    expect(logicalToPixel(10.9, 10.9, { x: 2, y: 2 })).toEqual({ px: 21, py: 21 })
  })
})

describe('clampPixel — 贴边不越界', () => {
  it('界内不变', () => {
    expect(clampPixel(100, 100, 1920, 1080)).toEqual({ px: 100, py: 100 })
  })
  it('超右下界 → 夹到 W-1/H-1', () => {
    expect(clampPixel(1920, 1080, 1920, 1080)).toEqual({ px: 1919, py: 1079 })
  })
  it('负 → 0', () => {
    expect(clampPixel(-5, -5, 1920, 1080)).toEqual({ px: 0, py: 0 })
  })
})

describe('formatColor', () => {
  it('HEX 大写补零', () => {
    expect(formatColor(0, 15, 255, 'hex')).toBe('#000FFF')
    expect(formatColor(45, 132, 196, 'hex')).toBe('#2D84C4')
  })
  it('rgb()', () => {
    expect(formatColor(45, 132, 196, 'rgb')).toBe('rgb(45, 132, 196)')
  })
})

describe('clampZoom', () => {
  it('界内不变', () => {
    expect(clampZoom(8)).toBe(8)
  })
  it('超界夹住', () => {
    expect(clampZoom(2)).toBe(4)
    expect(clampZoom(99)).toBe(20)
  })
})
