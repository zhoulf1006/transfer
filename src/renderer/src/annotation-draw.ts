import { arrowHead, type ShotElement } from '@shared/screenshot-annotation'

/**
 * 标注在 canvas 上的绘制(见 docs/screenshot-feature §3.3)。renderer 专用(用 CanvasRenderingContext2D)。
 *
 * ctx 已按需 translate(选区左上→原点)/scale(导出时 × ratio)。所有 element 坐标为**遮罩逻辑坐标**,
 * 传入前调用方负责换算到 ctx 的坐标系。这里只管"给定坐标系怎么画一个 element"。
 *
 * @param sample 底图物理像素采样 canvas(马赛克/模糊需要);坐标换算由 pxRect 提供
 * @param pxRect 逻辑矩形 → 底图物理像素矩形(马赛克/模糊从底图取区域)
 */
export function drawElement(
  ctx: CanvasRenderingContext2D,
  el: ShotElement,
  sample: HTMLCanvasElement | null,
  pxRect: (x: number, y: number, w: number, h: number) => { sx: number; sy: number; sw: number; sh: number },
  sizeScale: number
): void {
  const s = el.style
  ctx.save()
  ctx.globalAlpha = s.alpha
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.width * sizeScale
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  switch (el.type) {
    case 'rect':
      ctx.strokeRect(el.x, el.y, el.w, el.h)
      break
    case 'ellipse':
      ctx.beginPath()
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2)
      ctx.stroke()
      break
    case 'line':
      ctx.beginPath()
      ctx.moveTo(el.x1, el.y1)
      ctx.lineTo(el.x2, el.y2)
      ctx.stroke()
      break
    case 'arrow': {
      ctx.beginPath()
      ctx.moveTo(el.x1, el.y1)
      ctx.lineTo(el.x2, el.y2)
      const [w1, w2] = arrowHead(el.x1, el.y1, el.x2, el.y2, 8 + s.width * 2)
      ctx.moveTo(w1[0], w1[1])
      ctx.lineTo(el.x2, el.y2)
      ctx.lineTo(w2[0], w2[1])
      ctx.stroke()
      break
    }
    case 'pen':
    case 'marker': {
      if (el.points.length === 0) break
      if (el.type === 'marker') ctx.lineWidth = s.width * sizeScale * 2.5
      ctx.beginPath()
      ctx.moveTo(el.points[0][0], el.points[0][1])
      for (const [px, py] of el.points.slice(1)) ctx.lineTo(px, py)
      ctx.stroke()
      break
    }
    case 'text':
      ctx.textBaseline = 'top'
      ctx.font = `${el.fontSize * sizeScale}px -apple-system, "PingFang SC", sans-serif`
      ctx.fillText(el.text, el.x, el.y)
      break
    case 'badge': {
      const r = (10 + s.width) * sizeScale
      ctx.beginPath()
      ctx.arc(el.cx, el.cy, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = `bold ${r * 1.1}px -apple-system, sans-serif`
      ctx.fillText(String(el.n), el.cx, el.cy)
      break
    }
    case 'mosaic':
    case 'blur': {
      if (!sample) break
      const { sx, sy, sw, sh } = pxRect(el.x, el.y, el.w, el.h)
      if (sw <= 0 || sh <= 0) break
      ctx.save()
      ctx.beginPath()
      ctx.rect(el.x, el.y, el.w, el.h)
      ctx.clip()
      if (el.type === 'blur') {
        ctx.filter = `blur(${Math.max(2, s.width * 2) * sizeScale}px)`
        ctx.drawImage(sample, sx, sy, sw, sh, el.x, el.y, el.w, el.h)
      } else {
        // 马赛克:缩小再关平滑放大回去 → 块状
        const block = Math.max(6, s.width * 3)
        const smallW = Math.max(1, Math.round(el.w / block))
        const smallH = Math.max(1, Math.round(el.h / block))
        const tmp = document.createElement('canvas')
        tmp.width = smallW
        tmp.height = smallH
        const tctx = tmp.getContext('2d')!
        tctx.drawImage(sample, sx, sy, sw, sh, 0, 0, smallW, smallH)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(tmp, 0, 0, smallW, smallH, el.x, el.y, el.w, el.h)
      }
      ctx.restore()
      break
    }
  }
  ctx.restore()
}

