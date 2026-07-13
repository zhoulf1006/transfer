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
