/**
 * 截图标注数据模型 + 撤销栈纯逻辑(见 docs/screenshot-feature §4.4 / §4.7)。
 *
 * retained-mode:每个标注是带 type + 几何 + 样式的对象;重绘由 elements 数组驱动。
 * 坐标一律存**遮罩逻辑坐标**,导出时才 × ratio(阶段5 的 cropRect/尺寸量换算)。
 * 纯逻辑(对象增删、撤销重做、箭头几何)抽出便于单测;canvas 绘制在 renderer。
 */

export type ShotTool =
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'pen'
  | 'marker'
  | 'mosaic'
  | 'blur'
  | 'text'
  | 'badge'

export interface ShotStyle {
  color: string
  width: number
  /** 透明度 0-1(马克笔等半透明用) */
  alpha: number
}

export type ShotElement =
  | { id: string; type: 'rect' | 'ellipse' | 'mosaic' | 'blur'; x: number; y: number; w: number; h: number; style: ShotStyle }
  | { id: string; type: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; style: ShotStyle }
  | { id: string; type: 'pen' | 'marker'; points: Array<[number, number]>; style: ShotStyle }
  | { id: string; type: 'text'; x: number; y: number; text: string; fontSize: number; style: ShotStyle }
  | { id: string; type: 'badge'; cx: number; cy: number; n: number; style: ShotStyle }

/** 撤销栈深度上限(§4.4:防 points 密集时全量快照 O(M×N) 内存膨胀)。 */
export const UNDO_LIMIT = 50

export interface SceneState {
  elements: ShotElement[]
  undoStack: ShotElement[][]
  redoStack: ShotElement[][]
  badgeCounter: number
}

export function emptyScene(): SceneState {
  return { elements: [], undoStack: [], redoStack: [], badgeCounter: 0 }
}

/** 深拷贝一份 elements 快照(结构都是数字/字符串/小数组,structuredClone 够用)。 */
function snapshot(elements: ShotElement[]): ShotElement[] {
  return structuredClone(elements)
}

/**
 * 提交一次变更(新增/移动/删除后调用):先把当前 elements 压入 undo 栈(封顶),
 * 清空 redo,再落地新 elements。返回新 SceneState(不可变更新)。
 */
export function commit(s: SceneState, next: ShotElement[]): SceneState {
  const undoStack = [...s.undoStack, snapshot(s.elements)]
  // 封顶:超出丢最老一份(§4.4)
  if (undoStack.length > UNDO_LIMIT) undoStack.shift()
  return { ...s, elements: next, undoStack, redoStack: [] }
}

/** 撤销:elements 回退到上一份快照,当前压入 redo。无历史则不变。 */
export function undo(s: SceneState): SceneState {
  if (s.undoStack.length === 0) return s
  const prev = s.undoStack[s.undoStack.length - 1]
  return {
    ...s,
    elements: prev,
    undoStack: s.undoStack.slice(0, -1),
    redoStack: [...s.redoStack, snapshot(s.elements)]
  }
}

/** 重做:恢复下一份。无则不变。 */
export function redo(s: SceneState): SceneState {
  if (s.redoStack.length === 0) return s
  const next = s.redoStack[s.redoStack.length - 1]
  return {
    ...s,
    elements: next,
    undoStack: [...s.undoStack, snapshot(s.elements)],
    redoStack: s.redoStack.slice(0, -1)
  }
}

/** 清空所有标注(§4.7:Ctrl+Shift+Z;可撤销)。 */
export function clearAll(s: SceneState): SceneState {
  if (s.elements.length === 0) return s
  return commit(s, [])
}

/**
 * 箭头两条尾翼端点(纯几何,便于单测):
 * 主线 (x1,y1)->(x2,y2),在终点画两条回退线,长度 len、张角 ±angle。
 */
export function arrowHead(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  len = 14,
  angle = Math.PI / 7
): [[number, number], [number, number]] {
  const a = Math.atan2(y2 - y1, x2 - x1)
  return [
    [x2 - len * Math.cos(a - angle), y2 - len * Math.sin(a - angle)],
    [x2 - len * Math.cos(a + angle), y2 - len * Math.sin(a + angle)]
  ]
}
