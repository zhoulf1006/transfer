/**
 * 截图坐标/DPI 换算纯函数(见 docs/screenshot-feature §3.1/§3.3/§4.5)。
 *
 * 抽成纯函数便于单测:遮罩是逻辑坐标(DIP),位图是物理像素,两者靠 ratio 换算。
 * 关键坑:① 两轴 ratio 可能不等(非等比/系统取整);② 裁剪贴边越界(角点取整+clamp)。
 */

export interface Size {
  width: number
  height: number
}

export interface Ratios {
  x: number
  y: number
}

/**
 * 两轴缩放比 = 位图物理尺寸 / display 逻辑尺寸(§4.5)。
 * 用实测 bitmap 尺寸而非裸 scaleFactor:desktopCapturer 实际返回尺寸系统说了算,
 * 且 W/H 各自取整可能不等,故 X/Y 分开算。
 */
export function computeRatios(bitmap: Size, display: Size): Ratios {
  return {
    x: bitmap.width / display.width,
    y: bitmap.height / display.height
  }
}

export interface PixelRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * 逻辑选区 → 物理像素裁剪矩形(§4.5 关键坑)。
 *
 * **角点取整+作差**,而非对 x 和 w 分别 round:
 * sx=round(x·rx)、ex=round((x+w)·rx)、sw=ex-sx,保证 sx+sw 落在 [0,bitmapW],
 * 再末端 clamp 到位图尺寸,防贴右/下边越界导致 drawImage 源矩形溢出(透明缝/异常)。
 * 两轴各用各的 ratio。
 */
export function cropRect(
  sel: { x: number; y: number; w: number; h: number },
  ratio: Ratios,
  bitmap: Size
): PixelRect {
  const sx = clamp(Math.round(sel.x * ratio.x), 0, bitmap.width)
  const sy = clamp(Math.round(sel.y * ratio.y), 0, bitmap.height)
  const ex = clamp(Math.round((sel.x + sel.w) * ratio.x), 0, bitmap.width)
  const ey = clamp(Math.round((sel.y + sel.h) * ratio.y), 0, bitmap.height)
  return { sx, sy, sw: ex - sx, sh: ey - sy }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi))
}
