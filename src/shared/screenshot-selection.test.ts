import { describe, it, expect } from 'vitest'
import {
  rectFromPoints,
  clampRect,
  hitTest,
  applyDrag,
  nudge,
  isValidSelection,
  anchorLevel,
  type Rect
} from './screenshot-selection'

describe('rectFromPoints — 拖拽归一', () => {
  it('起点在左上', () => {
    expect(rectFromPoints(10, 20, 110, 220)).toEqual({ x: 10, y: 20, w: 100, h: 200 })
  })
  it('起点在右下(反向拖) → 归一成正矩形', () => {
    expect(rectFromPoints(110, 220, 10, 20)).toEqual({ x: 10, y: 20, w: 100, h: 200 })
  })
})

describe('clampRect — 边界约束', () => {
  const b = { w: 1000, h: 800 }
  it('选区在界内不变', () => {
    expect(clampRect({ x: 10, y: 10, w: 100, h: 100 }, b)).toEqual({ x: 10, y: 10, w: 100, h: 100 })
  })
  it('超出右下 → 推回界内', () => {
    expect(clampRect({ x: 950, y: 750, w: 100, h: 100 }, b)).toEqual({
      x: 900,
      y: 700,
      w: 100,
      h: 100
    })
  })
  it('负坐标 → 推回 0', () => {
    expect(clampRect({ x: -20, y: -30, w: 100, h: 100 }, b)).toEqual({ x: 0, y: 0, w: 100, h: 100 })
  })
  it('选区比遮罩还大 → 裁到遮罩尺寸', () => {
    expect(clampRect({ x: 0, y: 0, w: 2000, h: 2000 }, b)).toEqual({ x: 0, y: 0, w: 1000, h: 800 })
  })
})

describe('hitTest — 命中测试', () => {
  const r: Rect = { x: 100, y: 100, w: 200, h: 100 } // 右下角 (300,200)
  const tol = 6
  it('四角', () => {
    expect(hitTest(r, 100, 100, tol)).toBe('nw')
    expect(hitTest(r, 300, 100, tol)).toBe('ne')
    expect(hitTest(r, 100, 200, tol)).toBe('sw')
    expect(hitTest(r, 300, 200, tol)).toBe('se')
  })
  it('四边中点', () => {
    expect(hitTest(r, 200, 100, tol)).toBe('n')
    expect(hitTest(r, 200, 200, tol)).toBe('s')
    expect(hitTest(r, 100, 150, tol)).toBe('w')
    expect(hitTest(r, 300, 150, tol)).toBe('e')
  })
  it('内部 → move', () => {
    expect(hitTest(r, 200, 150, tol)).toBe('move')
  })
  it('外部远处 → null(重新框选)', () => {
    expect(hitTest(r, 500, 500, tol)).toBe(null)
  })
})

describe('applyDrag — 拖锚点/整块', () => {
  const r: Rect = { x: 100, y: 100, w: 200, h: 100 }
  it('拖整块', () => {
    expect(applyDrag(r, 'move', 50, -30)).toEqual({ x: 150, y: 70, w: 200, h: 100 })
  })
  it('拖 se 角放大', () => {
    expect(applyDrag(r, 'se', 20, 10)).toEqual({ x: 100, y: 100, w: 220, h: 110 })
  })
  it('拖 nw 角(改左上,反向)', () => {
    expect(applyDrag(r, 'nw', 20, 10)).toEqual({ x: 120, y: 110, w: 180, h: 90 })
  })
  it('拖 e 边只改宽', () => {
    expect(applyDrag(r, 'e', 30, 999)).toEqual({ x: 100, y: 100, w: 230, h: 100 })
  })
  it('拖过对边 → 翻面归一为正矩形', () => {
    // se 角往左拖超过左边界 250px:宽 200 - 250 = -50 → 归一
    const out = applyDrag(r, 'e', -250, 0)
    expect(out.w).toBeGreaterThanOrEqual(0)
    expect(out).toEqual({ x: 50, y: 100, w: 50, h: 100 })
  })
})

describe('nudge — 键盘像素微调(跟手方向)', () => {
  const r: Rect = { x: 100, y: 100, w: 50, h: 50 } // 边界 L100 T100 R150 B150

  it('移动(无修饰)', () => {
    expect(nudge(r, 1, 0, 'move')).toEqual({ x: 101, y: 100, w: 50, h: 50 })
    expect(nudge(r, 0, -1, 'move')).toEqual({ x: 100, y: 99, w: 50, h: 50 })
  })

  // 回归:曾用 Math.abs 导致"上下都向下扩、左右都向右扩"。现按方向键各扩对应边。
  it('expand 各方向扩对应边界', () => {
    expect(nudge(r, 1, 0, 'expand')).toEqual({ x: 100, y: 100, w: 51, h: 50 }) // 右外扩
    expect(nudge(r, -1, 0, 'expand')).toEqual({ x: 99, y: 100, w: 51, h: 50 }) // 左外扩
    expect(nudge(r, 0, -1, 'expand')).toEqual({ x: 100, y: 99, w: 50, h: 51 }) // 上外扩
    expect(nudge(r, 0, 1, 'expand')).toEqual({ x: 100, y: 100, w: 50, h: 51 }) // 下外扩
  })

  it('shrink 各方向收对应边界', () => {
    expect(nudge(r, 1, 0, 'shrink')).toEqual({ x: 100, y: 100, w: 49, h: 50 }) // 右内收
    expect(nudge(r, -1, 0, 'shrink')).toEqual({ x: 101, y: 100, w: 49, h: 50 }) // 左内收
    expect(nudge(r, 0, -1, 'shrink')).toEqual({ x: 100, y: 101, w: 50, h: 49 }) // 上内收
    expect(nudge(r, 0, 1, 'shrink')).toEqual({ x: 100, y: 100, w: 50, h: 49 }) // 下内收
  })

  it('上扩与下扩方向相反(旧 abs bug 会让二者相同)', () => {
    expect(nudge(r, 0, -1, 'expand')).not.toEqual(nudge(r, 0, 1, 'expand'))
    expect(nudge(r, -1, 0, 'expand')).not.toEqual(nudge(r, 1, 0, 'expand'))
  })

  it('缩小不低于 1×1', () => {
    const tiny: Rect = { x: 0, y: 0, w: 1, h: 1 }
    const out = nudge(tiny, 1, 0, 'shrink')
    expect(out.w).toBe(1)
  })
})

describe('isValidSelection / anchorLevel — 阈值', () => {
  it('过小选区无效', () => {
    expect(isValidSelection({ x: 0, y: 0, w: 3, h: 100 })).toBe(false)
    expect(isValidSelection({ x: 0, y: 0, w: 4, h: 4 })).toBe(true)
  })
  it('锚点隐藏级别按短边', () => {
    expect(anchorLevel({ x: 0, y: 0, w: 100, h: 100 })).toBe('all')
    expect(anchorLevel({ x: 0, y: 0, w: 100, h: 30 })).toBe('corners')
    expect(anchorLevel({ x: 0, y: 0, w: 100, h: 15 })).toBe('none')
  })
})
