/**
 * 截图取色/放大镜纯逻辑(见 docs/screenshot-feature §2.4 / §4.7)。
 *
 * 换算统一以 ShotSource 的两轴 ratio 为唯一真源(§4.5),不用 window.devicePixelRatio。
 */

export interface Ratios {
  x: number
  y: number
}

/** 逻辑坐标(遮罩内)→ 背景位图物理像素坐标(取色采样用)。 */
export function logicalToPixel(lx: number, ly: number, ratio: Ratios): { px: number; py: number } {
  return { px: Math.floor(lx * ratio.x), py: Math.floor(ly * ratio.y) }
}

/** clamp 像素坐标进位图范围(贴边不越界)。 */
export function clampPixel(
  px: number,
  py: number,
  bitmapW: number,
  bitmapH: number
): { px: number; py: number } {
  return {
    px: Math.max(0, Math.min(px, bitmapW - 1)),
    py: Math.max(0, Math.min(py, bitmapH - 1))
  }
}

export type ColorFormat = 'hex' | 'rgb'

/** RGB 分量(0-255)格式化成 HEX(大写)或 rgb() 字符串。 */
export function formatColor(r: number, g: number, b: number, fmt: ColorFormat): string {
  if (fmt === 'rgb') return `rgb(${r}, ${g}, ${b})`
  const h = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase()
  return `#${h(r)}${h(g)}${h(b)}`
}

/** 放大镜倍率:滚轮增减,clamp 到 [min,max]。 */
export function clampZoom(zoom: number, min = 4, max = 20): number {
  return Math.max(min, Math.min(max, zoom))
}
