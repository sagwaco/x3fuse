import type { ScopeMode, ThemeName } from '@shared/types'
import {
  chroma,
  COLOR_TARGETS,
  histogram,
  scopeDensitySteps,
  SCOPE_PALETTES,
  type ScopePalette,
  SKIN_TONE_ANGLE
} from './scopes'

export interface ScopeRenderRequest {
  image: ImageData
  mode: ScopeMode
  width: number
  pixelRatio: number
  /** The theme whose surface the scope is drawn for. Dark when not set. */
  theme?: ThemeName
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const TOP = 15
const PLOT_HEIGHT = 166
// The waveform scale is absolute, in 10-bit levels.
const LEVELS = [0, 256, 512, 768, 1024]
const levelY = (value: number): number => TOP + (1 - value / 1024) * (PLOT_HEIGHT - 1)

// The width of the widest level label, "1024", in 9 px Kode Mono at 87.5 % width.
const LABEL_WIDTH = 19
// The gap between a level label and the plot.
const LABEL_GAP = 5

/** The left edge and the width of the plot of a waveform, a parade or a histogram. */
function plotArea(mode: ScopeMode, width: number): { left: number; plotWidth: number } {
  // The 4 px margins and the 12 px scope padding put the scope edges on the 16 px edges
  // of the editor controls. The histogram plot uses these edges. The waveform and the
  // parade put their level labels at the left edge, and their plot after the labels.
  const left = mode === 'histogram' ? 4 : 4 + LABEL_WIDTH + LABEL_GAP
  return { left, plotWidth: Math.max(1, Math.floor(width - left - 4)) }
}

export interface ScopeLabel {
  text: string
  /** The anchor in CSS pixels. `y` is the middle of the text. */
  x: number
  y: number
  align: 'left' | 'center' | 'right'
}

/**
 * The axis labels of a scope. The scope shows them over its canvas, so that they can
 * change on hover without a new render.
 */
export function scopeLabels(mode: ScopeMode, width: number): ScopeLabel[] {
  if (mode === 'vectorscope') return []
  const { left, plotWidth } = plotArea(mode, width)
  if (mode === 'histogram')
    return [0, 64, 128, 192, 255].map((value) => ({
      text: String(value),
      x: left + (value / 255) * (plotWidth - 1),
      y: 192,
      align: value === 0 ? 'left' : value === 255 ? 'right' : 'center'
    }))
  return LEVELS.map((value) => ({
    text: String(value),
    x: left - LABEL_GAP,
    y: levelY(value),
    align: 'right'
  }))
}

/** Identical drawing on the worker and on older webviews, with yield points for the latter. */
export function* drawScope(
  ctx: Context,
  { image, mode, width, pixelRatio, theme = 'dark' }: ScopeRenderRequest
): Generator<void> {
  const palette = SCOPE_PALETTES[theme]
  ctx.scale(pixelRatio, pixelRatio)
  // The weight and width match the font variation settings in tailwind.config.ts.
  ctx.font = '500 semi-condensed 12px "Kode Mono", monospace'
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
    yield* drawDensity(
      ctx,
      layers[0],
      densitySize,
      densitySize,
      x,
      y,
      pixelRatio,
      palette.vector,
      palette
    )
    ctx.strokeStyle = palette.rings
    for (const fraction of [0.5, 1]) {
      ctx.beginPath()
      ctx.arc(cx, cy, radius * fraction, 0, Math.PI * 2)
      ctx.stroke()
    }
    line(ctx, cx - radius, cy, cx + radius, cy)
    line(ctx, cx, cy - radius, cx, cy + radius)
    ctx.strokeStyle = palette.skin
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
      ctx.strokeStyle = palette.target
      ctx.strokeRect(tx - 3, ty - 3, 6, 6)
      ctx.fillStyle = palette.target
      const length = Math.hypot(cb, cr)
      ctx.fillText(target.label, tx + (cb / length) * 12, ty - (cr / length) * 12)
    }
    return
  }

  const { left, plotWidth } = plotArea(mode, width)
  ctx.strokeStyle = palette.grid
  for (const value of LEVELS) line(ctx, left, levelY(value), left + plotWidth - 1, levelY(value))
  if (mode === 'histogram') {
    const bins = histogram(image)
    const max = Math.max(1, ...bins.map((channel) => Math.max(...channel)))
    bins.forEach((channel, c) => {
      ctx.beginPath()
      ctx.moveTo(left, TOP + PLOT_HEIGHT - 1)
      for (let i = 0; i < 256; i++) {
        ctx.lineTo(
          left + (i / 255) * (plotWidth - 1),
          TOP + (1 - channel[i] / max) * (PLOT_HEIGHT - 1)
        )
      }
      ctx.lineTo(left + plotWidth - 1, TOP + PLOT_HEIGHT - 1)
      ctx.closePath()
      ctx.fillStyle = palette.channels[c]
      ctx.globalAlpha = 0.25
      ctx.fill()
      ctx.globalAlpha = 0.9
      ctx.strokeStyle = palette.channels[c]
      ctx.stroke()
      ctx.globalAlpha = 1
    })
    return
  }

  const gap = 5
  const channelWidth =
    mode === 'rgbParade' ? Math.max(1, Math.floor((plotWidth - gap * 2) / 3)) : plotWidth
  const densityWidth = Math.max(1, Math.round(channelWidth * pixelRatio))
  const densityHeight = Math.max(1, Math.round(PLOT_HEIGHT * pixelRatio))
  const layers = yield* scopeDensitySteps(image, mode, densityWidth, densityHeight)
  for (const [c, layer] of layers.entries()) {
    // The outer channels touch the plot edges, so the parade fills the same width.
    const x = left + Math.round((c * (plotWidth - channelWidth)) / 2)
    yield* drawDensity(
      ctx,
      layer,
      densityWidth,
      densityHeight,
      x,
      TOP,
      pixelRatio,
      palette.channels[c],
      palette,
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
  { blend, density }: ScopePalette,
  opacity = 1
): Generator<void> {
  let max = 0
  for (let i = 0; i < counts.length; i++) if (counts[i] > max) max = counts[i]
  if (max === 0) return
  const scale = (density * opacity) / Math.log1p(max)
  // One density bin per device pixel. Splat each as a round point 0.75 device px in
  // radius: it covers its own pixel and ~0.19 of each edge neighbour. Accumulating
  // alpha here and compositing once replaces one canvas arc per bin.
  const edge = 0.19
  const alpha = new Float32Array(width * height)
  for (let row = 0, i = 0; row < height; row++) {
    if (row % 128 === 127) yield
    for (let column = 0; column < width; column++, i++) {
      if (!counts[i]) continue
      const a = Math.log1p(counts[i]) * scale
      alpha[i] += a
      if (column > 0) alpha[i - 1] += a * edge
      if (column < width - 1) alpha[i + 1] += a * edge
      if (row > 0) alpha[i - width] += a * edge
      if (row < height - 1) alpha[i + width] += a * edge
    }
  }
  const layer =
    typeof OffscreenCanvas === 'undefined'
      ? Object.assign(document.createElement('canvas'), { width, height })
      : new OffscreenCanvas(width, height)
  const layerContext = layer.getContext('2d') as Context | null
  if (!layerContext) throw new Error('2D canvas unavailable')
  const pixels = layerContext.createImageData(width, height)
  const { data } = pixels
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
  for (let i = 0; i < alpha.length; i++) {
    if (!alpha[i]) continue
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = alpha[i] * 255
  }
  layerContext.putImageData(pixels, 0, 0)
  ctx.globalCompositeOperation = blend
  ctx.drawImage(layer, x, y, width / pixelRatio, height / pixelRatio)
  ctx.globalCompositeOperation = 'source-over'
}
