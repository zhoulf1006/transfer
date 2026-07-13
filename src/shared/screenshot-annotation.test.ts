import { describe, it, expect } from 'vitest'
import {
  emptyScene,
  commit,
  undo,
  redo,
  clearAll,
  arrowHead,
  UNDO_LIMIT,
  type ShotElement,
  type SceneState
} from './screenshot-annotation'

const rect = (id: string): ShotElement => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  style: { color: '#f00', width: 2, alpha: 1 }
})

describe('commit / undo / redo', () => {
  it('commit 落地新 elements 并存历史', () => {
    let s = emptyScene()
    s = commit(s, [rect('a')])
    expect(s.elements.map((e) => e.id)).toEqual(['a'])
    expect(s.undoStack).toHaveLength(1) // 存了提交前的空数组
  })

  it('undo 回退,redo 恢复', () => {
    let s = emptyScene()
    s = commit(s, [rect('a')])
    s = commit(s, [rect('a'), rect('b')])
    expect(s.elements).toHaveLength(2)
    s = undo(s)
    expect(s.elements.map((e) => e.id)).toEqual(['a'])
    s = undo(s)
    expect(s.elements).toEqual([])
    s = redo(s)
    expect(s.elements.map((e) => e.id)).toEqual(['a'])
    s = redo(s)
    expect(s.elements.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('空历史 undo/redo 不变', () => {
    const s = emptyScene()
    expect(undo(s)).toBe(s)
    expect(redo(s)).toBe(s)
  })

  it('新 commit 清空 redo(分叉)', () => {
    let s = emptyScene()
    s = commit(s, [rect('a')])
    s = undo(s) // redo 里有 [a]
    expect(s.redoStack).toHaveLength(1)
    s = commit(s, [rect('c')]) // 新提交清 redo
    expect(s.redoStack).toHaveLength(0)
    expect(redo(s).elements.map((e) => e.id)).toEqual(['c']) // redo 无效果
  })

  it('撤销栈封顶 UNDO_LIMIT,超出丢最老', () => {
    let s: SceneState = emptyScene()
    for (let i = 0; i < UNDO_LIMIT + 10; i++) s = commit(s, [rect(`e${i}`)])
    expect(s.undoStack.length).toBe(UNDO_LIMIT)
  })

  it('结构隔离:undo 后修改返回值不影响原快照', () => {
    let s = emptyScene()
    s = commit(s, [rect('a')])
    const back = undo(s)
    back.elements.push(rect('x')) // 改副本
    expect(redo(s).elements.map((e) => e.id)).toEqual(['a']) // 原历史不受污染
  })
})

describe('clearAll', () => {
  it('清空且可撤销', () => {
    let s = emptyScene()
    s = commit(s, [rect('a'), rect('b')])
    s = clearAll(s)
    expect(s.elements).toEqual([])
    s = undo(s)
    expect(s.elements).toHaveLength(2)
  })
  it('已空则不变', () => {
    const s = emptyScene()
    expect(clearAll(s)).toBe(s)
  })
})

describe('arrowHead — 箭头尾翼几何', () => {
  it('水平向右箭头,尾翼在终点左侧', () => {
    const [w1, w2] = arrowHead(0, 0, 100, 0)
    expect(w1[0]).toBeLessThan(100) // 尾翼 x 在终点左边
    expect(w2[0]).toBeLessThan(100)
    // 两翼对称分布在主线上下
    expect(Math.sign(w1[1])).toBe(-Math.sign(w2[1]))
  })
  it('长度参数生效', () => {
    const [w1] = arrowHead(0, 0, 100, 0, 20, Math.PI / 6)
    const dist = Math.hypot(100 - w1[0], 0 - w1[1])
    expect(dist).toBeCloseTo(20, 5)
  })
})
