/**
 * 截图选区交互纯逻辑(见 docs/screenshot-feature §2.3 / §4.7)。
 *
 * 全部用**遮罩逻辑坐标**(与遮罩窗一致);导出时才 × ratio 到物理像素(阶段5)。
 * 抽成纯函数便于单测:框选/拖锚点/拖整块/像素微调/锚点隐藏都是可验证的几何。
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 遮罩(屏幕)逻辑尺寸,选区不能超出。 */
export interface Bounds {
  w: number
  h: number
}

/** 8 个缩放锚点(角+边)+ 拖整块。 */
export type Anchor = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export type Handle = Anchor | 'move'

/** 拖拽两点归一成正矩形(起点可能在任意角)。 */
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0)
  }
}

/** 选区 clamp 进遮罩边界(不改大小,只推回;超大则贴边裁)。 */
export function clampRect(r: Rect, b: Bounds): Rect {
  const w = Math.min(r.w, b.w)
  const h = Math.min(r.h, b.h)
  const x = Math.max(0, Math.min(r.x, b.w - w))
  const y = Math.max(0, Math.min(r.y, b.h - h))
  return { x, y, w, h }
}

/**
 * 命中测试:给一个点(逻辑坐标)落在选区的哪个交互区。
 * 锚点判定用 tol(像素容差);都不中且在选区内 → 'move';否则 null(重新框选)。
 */
export function hitTest(r: Rect, px: number, py: number, tol: number): Handle | null {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= tol
  const onL = near(px, r.x)
  const onR = near(px, r.x + r.w)
  const onT = near(py, r.y)
  const onB = near(py, r.y + r.h)
  const inX = px >= r.x - tol && px <= r.x + r.w + tol
  const inY = py >= r.y - tol && py <= r.y + r.h + tol
  if (inX && inY) {
    if (onT && onL) return 'nw'
    if (onT && onR) return 'ne'
    if (onB && onL) return 'sw'
    if (onB && onR) return 'se'
    if (onT) return 'n'
    if (onB) return 's'
    if (onL) return 'w'
    if (onR) return 'e'
  }
  // 内部(不含边缘容差带)→ 拖整块
  if (px > r.x && px < r.x + r.w && py > r.y && py < r.y + r.h) return 'move'
  return null
}

/**
 * 按住某锚点/整块拖动 dx,dy 后的新选区(未 clamp)。
 * 锚点缩放允许翻面(拖过对边):最后统一 normalize 成正矩形。
 */
export function applyDrag(orig: Rect, handle: Handle, dx: number, dy: number): Rect {
  if (handle === 'move') return { ...orig, x: orig.x + dx, y: orig.y + dy }
  let { x, y, w, h } = orig
  let l = x
  let t = y
  let rr = x + w
  let bb = y + h
  if (handle.includes('w')) l = x + dx
  if (handle.includes('e')) rr = x + w + dx
  if (handle.includes('n')) t = y + dy
  if (handle.includes('s')) bb = y + h + dy
  return rectFromPoints(l, t, rr, bb)
}

/**
 * 键盘像素微调(§2.3),跟手方向:方向键决定作用哪条边,mod 决定往外扩还是往内收。
 * dir 为方向单位向量(→={1,0} ←={-1,0} ↑={0,-1} ↓={0,1}),dx/dy 的符号选边:
 * - move:整体平移 dx,dy
 * - expand:沿该方向把对应边界外推(Ctrl+右=右边外扩、Ctrl+左=左边外扩、Ctrl+上=上边外扩、Ctrl+下=下边外扩)
 * - shrink:沿该方向把对应边界内收(Shift+右=右边内收…),不小于 1×1
 * 归一后返回正矩形(内收可能翻面)。
 */
export type NudgeMod = 'move' | 'expand' | 'shrink'
export function nudge(r: Rect, dx: number, dy: number, mod: NudgeMod): Rect {
  if (mod === 'move') return { ...r, x: r.x + dx, y: r.y + dy }
  const s = mod === 'expand' ? 1 : -1 // 外扩=边界背离选区,内收=边界朝向选区
  let l = r.x
  let t = r.y
  let rr = r.x + r.w
  let bb = r.y + r.h
  if (dx > 0) rr += s // 右边界:expand 外推(+),shrink 内收(-)
  else if (dx < 0) l -= s // 左边界:expand 外推(-),shrink 内收(+)
  if (dy > 0) bb += s // 下边界
  else if (dy < 0) t -= s // 上边界
  const out = rectFromPoints(l, t, rr, bb)
  return { ...out, w: Math.max(1, out.w), h: Math.max(1, out.h) }
}

/** 选区是否有效(达到最小尺寸才出工具条/可导出,§4.5)。 */
export function isValidSelection(r: Rect, min = 4): boolean {
  return r.w >= min && r.h >= min
}

/**
 * 锚点显示级别(§4.5:选区过小时锚点自动隐藏,独立于有效阈值):
 * - 'all':短边 ≥ 40,显示全部 8 锚点
 * - 'none':短边 < 20,全隐(仍可整块拖/键盘微调)
 * - 'corners':之间,只显示 4 角锚点
 */
export function anchorLevel(r: Rect): 'all' | 'corners' | 'none' {
  const short = Math.min(r.w, r.h)
  if (short < 20) return 'none'
  if (short < 40) return 'corners'
  return 'all'
}
