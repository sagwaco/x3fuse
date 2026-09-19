import { useLayoutEffect, useRef } from 'react'
import { Skeleton } from '@radix-ui/themes/components/skeleton'
import '@radix-ui/themes/src/components/skeleton.css'
import type { ScopeMode } from '@shared/types'
import { useScopeImage } from '../hooks/useScopeImage'
import { useElementWidth } from '../hooks/useElementWidth'
import { useDelayedLoading } from '../hooks/useDelayedLoading'
import { t } from '../lib/strings'
import {
  chroma,
  COLOR_TARGETS,
  histogram,
  scopeDensity,
  SCOPE_COLORS,
  SKIN_TONE_ANGLE
} from '../lib/scopes'

export function ColorScope({
  url,
  aspectRatio,
  orientation,
  fileId,
  pending = false,
  mode
}: {
  url: string | undefined
  aspectRatio?: number
  orientation?: number
  fileId?: string
  pending?: boolean
  mode: ScopeMode
}): React.JSX.Element {
  const image = useScopeImage(url, aspectRatio, orientation, fileId)
  const loading = pending || image === 'loading'
  const showLoading = useDelayedLoading(loading, fileId ?? url)
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const width = useElementWidth(container)

  useLayoutEffect(() => {
    const drawWidth = width || container.current?.clientWidth || 0
    if (!canvas.current || !image || image === 'loading' || drawWidth <= 0) return
    const element = canvas.current
    const draw = (): void => {
      const ratio = window.devicePixelRatio || 1
      element.width = Math.round(drawWidth * ratio)
      element.height = 200 * ratio
      const ctx = element.getContext('2d')
      if (!ctx) return
      ctx.scale(ratio, ratio)
      drawScope(ctx, image, mode, drawWidth)
    }
    draw()
    window.addEventListener('resize', draw)
    return () => window.removeEventListener('resize', draw)
  }, [image, mode, width])

  return (
    <div
      ref={container}
      aria-busy={loading}
      className="relative h-[200px] overflow-hidden rounded bg-neutral-950/60"
    >
      {loading ? (
        showLoading ? (
          <div className="h-full" role="status" aria-label={t('inspector.scope_loading')}>
            <Skeleton className="preview-skeleton h-full w-full" />
          </div>
        ) : null
      ) : !image ? (
        <p className="flex h-full items-center justify-center text-xs text-neutral-600">
          {t('inspector.no_preview')}
        </p>
      ) : (
        <canvas
          ref={canvas}
          className="h-full w-full"
          role="img"
          aria-label={t(`inspector.scope_${mode}`)}
        />
      )}
    </div>
  )
}

function drawScope(
  ctx: CanvasRenderingContext2D,
  image: ImageData,
  mode: ScopeMode,
  width: number
): void {
  ctx.font = '9px system-ui'
  ctx.lineWidth = 0.5
  if (mode === 'vectorscope') {
    const size = Math.floor(Math.min(width - 24, 176))
    const x = (width - size) / 2
    const y = (200 - size) / 2
    const radius = (size - 1) / 2
    const cx = x + radius
    const cy = y + radius
    drawDensity(ctx, scopeDensity(image, mode, size, size)[0], size, size, x, y, '#d4e5dc')
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
  const channelWidth = mode === 'rgbParade' ? Math.floor((plotWidth - gap * 2) / 3) : plotWidth
  const layers = scopeDensity(image, mode, channelWidth, plotHeight)
  layers.forEach((layer, c) => {
    const x = left + (mode === 'rgbParade' ? c * (channelWidth + gap) : 0)
    drawDensity(ctx, layer, channelWidth, plotHeight, x, top, SCOPE_COLORS[c], c === 3 ? 0.55 : 1)
  })
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function drawDensity(
  ctx: CanvasRenderingContext2D,
  counts: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  color: string,
  opacity = 1
): void {
  let max = 0
  for (const count of counts) max = Math.max(max, count)
  if (max === 0) return
  const scale = Math.log1p(max)
  ctx.fillStyle = color
  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < width * height; i++) {
    if (!counts[i]) continue
    // Native canvas curves antialias at the display scale. Compensate for the
    // larger round footprint so smoothing doesn't wash out dense traces.
    // Let fractional coverage fade to zero instead of imposing a brightness floor.
    ctx.globalAlpha = (0.6 * opacity * Math.log1p(counts[i])) / scale
    ctx.beginPath()
    ctx.arc(x + (i % width) + 0.5, y + Math.floor(i / width) + 0.5, 0.75, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}
