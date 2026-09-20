import type { ScopeMode } from '@shared/types'
import {
  chroma,
  COLOR_TARGETS,
  histogram,
  scopeDensitySteps,
  SCOPE_COLORS,
  SKIN_TONE_ANGLE
} from './scopes'

export interface ScopeRenderRequest {
  image: ImageData
  mode: ScopeMode
  width: number
  pixelRatio: number
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Identical drawing on the worker and on older webviews, with yield points for the latter. */
export function* drawScope(
  ctx: Context,
  { image, mode, width, pixelRatio }: ScopeRenderRequest
): Generator<void> {
  ctx.scale(pixelRatio, pixelRatio)
  ctx.font = '9px system-ui'
  ctx.lineWidth = 0.5
  if (mode === 'vectorscope') {
    const size = Math.max(1, Math.floor(Math.min(width - 24, 176)))
    const densitySize = Math.max(1, Math.round(size * pixelRatio))
    const x = (width - size) / 2
    const y = (200 - size) / 2
    const radius = (densitySize - 1) / (2 * pixelRatio)
    const cx = x + densitySize / (2 * pixelRatio)
    const cy = y + densitySize / (2 * pixelRatio)
    const layers = yield* scopeDensitySteps(image, mode, densitySize, densitySize)
    yield* drawDensity(ctx, layers[0], densitySize, densitySize, x, y, pixelRatio, '#d4e5dc')
    ctx.strokeStyle = '#737373'
    for (const fraction of [0.5, 1]) {
      ctx.beginPath()
      ctx.arc(cx, cy, radius * fraction, 0, Math.PI * 2)
      ctx.stroke()
    }
    line(ctx, cx - radius, cy, cx + radius, cy)
    line(ctx, cx, cy - radius, cx, cy + radius)
    ctx.strokeStyle = '#d4a574'
    ctx.setLineDash([3, 3])
    line(
      ctx,
      cx,
      cy,
      cx + Math.cos(SKIN_TONE_ANGLE) * radius,
      cy - Math.sin(SKIN_TONE_ANGLE) * radius
    )
    ctx.setLineDash([])
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const target of COLOR_TARGETS) {
      const [cb, cr] = chroma(target.rgb[0], target.rgb[1], target.rgb[2])
      const tx = cx + cb * radius
      const ty = cy - cr * radius
      ctx.strokeStyle = '#a3a3a3'
      ctx.strokeRect(tx - 3, ty - 3, 6, 6)
      ctx.fillStyle = '#a3a3a3'
      const length = Math.hypot(cb, cr)
      ctx.fillText(target.label, tx + (cb / length) * 12, ty - (cr / length) * 12)
    }
    return
  }

  const left = mode === 'histogram' ? 29 : 36
  const top = 15
  const plotWidth = Math.max(1, Math.floor(width - left - 8))
  const plotHeight = 166
  ctx.textBaseline = 'middle'
  for (const value of [0, 25, 50, 75, 100]) {
    const y = top + (1 - value / 100) * (plotHeight - 1)
    ctx.strokeStyle = '#404040'
    line(ctx, left, y, left + plotWidth - 1, y)
    if (mode !== 'histogram') {
      ctx.fillStyle = '#737373'
      ctx.textAlign = 'right'
      ctx.fillText(`${value}%`, left - 5, y)
    }
  }
  if (mode === 'histogram') {
    const bins = histogram(image)
    const max = Math.max(1, ...bins.map((channel) => Math.max(...channel)))
    bins.forEach((channel, c) => {
      ctx.beginPath()
      ctx.moveTo(left, top + plotHeight - 1)
      for (let i = 0; i < 256; i++) {
        ctx.lineTo(
          left + (i / 255) * (plotWidth - 1),
          top + (1 - channel[i] / max) * (plotHeight - 1)
        )
      }
      ctx.lineTo(left + plotWidth - 1, top + plotHeight - 1)
      ctx.closePath()
      ctx.fillStyle = SCOPE_COLORS[c]
      ctx.globalAlpha = 0.25
      ctx.fill()
      ctx.globalAlpha = 0.9
      ctx.strokeStyle = SCOPE_COLORS[c]
      ctx.stroke()
      ctx.globalAlpha = 1
    })
    ctx.fillStyle = '#737373'
    for (const value of [0, 64, 128, 192, 255]) {
      ctx.textAlign = value === 0 ? 'left' : value === 255 ? 'right' : 'center'
      ctx.fillText(String(value), left + (value / 255) * (plotWidth - 1), 192)
    }
    return
  }

  const gap = 5
  const channelWidth =
    mode === 'rgbParade' ? Math.max(1, Math.floor((plotWidth - gap * 2) / 3)) : plotWidth
  const densityWidth = Math.max(1, Math.round(channelWidth * pixelRatio))
  const densityHeight = Math.max(1, Math.round(plotHeight * pixelRatio))
  const layers = yield* scopeDensitySteps(image, mode, densityWidth, densityHeight)
  for (const [c, layer] of layers.entries()) {
    const x = left + (mode === 'rgbParade' ? c * (channelWidth + gap) : 0)
    yield* drawDensity(
      ctx,
      layer,
      densityWidth,
      densityHeight,
      x,
      top,
      pixelRatio,
      SCOPE_COLORS[c],
      c === 3 ? 0.55 : 1
    )
  }
}

function line(ctx: Context, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function* drawDensity(
  ctx: Context,
  counts: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  pixelRatio: number,
  color: string,
  opacity = 1
): Generator<void> {
  let max = 0
  for (const count of counts) max = Math.max(max, count)
  if (max === 0) return
  const scale = Math.log1p(max)
  ctx.fillStyle = color
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < width * height; i++) {
    if (i > 0 && i % 256 === 0) yield
    if (!counts[i]) continue
    // Density bins and point radius stay in physical pixels on high-DPI displays.
    ctx.globalAlpha = (0.6 * opacity * Math.log1p(counts[i])) / scale
    ctx.beginPath()
    ctx.arc(
      x + ((i % width) + 0.5) / pixelRatio,
      y + (Math.floor(i / width) + 0.5) / pixelRatio,
      0.75 / pixelRatio,
      0,
      Math.PI * 2
    )
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}
