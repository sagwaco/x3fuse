import { useCallback, useEffect, useId, useRef, type MouseEvent, type PointerEvent } from 'react'
import { mixPoint, pointMix, mixPadPoint, padPointMix, type LayerMix } from '../lib/ternaryMix'
import { appInfo } from '../lib/appInfo'
import { ipc } from '../lib/ipc'
import { blurOnEnter } from '../lib/commitFocus'
import { cn } from '../lib/cn'
import { t } from '../lib/strings'

const layers = ['Bottom', 'Middle', 'Top'] as const
/** The pad distance between haptic ticks in a drag: about 10% of the mix. */
const HAPTIC_STEP = 0.5
/** The handle hit radius, in pad units. */
const HANDLE = 0.6
/** Label text and positions: BOT bottom right, MID bottom left, TOP top center. */
const labels = [
  { text: 'BOT', x: 6.4, y: 6.2 },
  { text: 'MID', x: -6.4, y: 6.2 },
  { text: 'TOP', x: 0, y: -5.2 }
]
/**
 * The dot grid, one layer per color channel. Near the pad edge, the glass
 * smears each dot along the edge normal and moves it out, more strongly closer
 * to the edge. Red moves most and blue least, which splits colors at the edge.
 */
const GRID = [0.5, 0.3, 0.1].map((shift) => {
  const band = 2
  const bend = (v: number, low: number, high: number): { v: number; t: number } => {
    const t = Math.max(0, 1 - Math.min(v - low, high - v) / band) ** 2
    return { v: v + Math.sign(v - (low + high) / 2) * shift * t, t }
  }
  const dots: { cx: number; cy: number; rx: number; ry: number }[] = []
  for (let y = -6; y <= 7; y += 0.5)
    for (let x = -7.5; x <= 7.5; x += 0.5) {
      const bx = bend(x, -8, 8)
      const by = bend(y, -6.3, 7.3)
      // In a corner, the nearer edge sets the smear, so the dot does not swell.
      const t = Math.max(bx.t, by.t)
      const long = 0.035 * (1 + 5 * t)
      const thin = 0.035 * (1 - 0.3 * t)
      dots.push({
        cx: bx.v,
        cy: by.v,
        rx: bx.t >= by.t ? long : thin,
        ry: bx.t >= by.t ? thin : long
      })
    }
  return dots
})
/** The grid never changes, so React skips it when the pad renders again, as on each animation frame. */
const GRID_LAYER = (
  <g className="mix-grid">
    {GRID.map((dots, channel) => (
      <g key={channel}>
        {dots.map((dot, index) => (
          <ellipse key={index} {...dot} />
        ))}
      </g>
    ))}
  </g>
)
/** The light color for a mix: B red, M green, T blue. Negative weights add no light. */
const mixLight = (value: LayerMix): string => {
  const weights = value.map((v) => Math.max(0, v))
  const top = Math.max(...weights) || 1
  return `rgb(${weights.map((v) => Math.round((v / top) * 255)).join(' ')})`
}

export function TernaryMixPad({
  value,
  disabled,
  change,
  commit,
  reset,
  glow,
  shown = value
}: {
  value: LayerMix
  disabled: boolean
  change: (value: LayerMix, save: boolean) => void
  commit: () => void
  reset: () => void
  /** The color of the glow at the bottom of the pad. */
  glow?: string
  /** The mix that the handle shows, for example during a channel switch. */
  shown?: LayerMix
}): React.JSX.Element {
  const description = useId()
  // SVG url() references need plain ids.
  const cutout = `mix-label${useId().replace(/\W/g, '')}`
  const pad = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    pointer: number
    x: number
    y: number
    point: { x: number; y: number }
    /** Pad distance since the last haptic tick. */
    travel: number
  } | null>(null)
  const end = useCallback(() => {
    if (!drag.current) return
    drag.current = null
    delete pad.current?.dataset.dragging
    commit()
  }, [commit])
  useEffect(() => end, [disabled, end])
  const position = mixPadPoint(value)
  const handle = mixPadPoint(shown)
  const point = (event: MouseEvent<HTMLDivElement>): { x: number; y: number } => {
    const box = event.currentTarget.getBoundingClientRect()
    return {
      x: ((event.clientX - box.left) / box.width) * 16 - 8,
      y: 6.3 - ((event.clientY - box.top) / box.height) * 13.6
    }
  }
  const follow = (event: PointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    if (!held || held.pointer !== event.pointerId || disabled) return
    const cursor = point(event)
    if (cursor.x === held.x && cursor.y === held.y) return
    const scale = event.altKey ? 0.1 : 1
    const next = {
      x: held.point.x + (cursor.x - held.x) * scale,
      y: held.point.y + (cursor.y - held.y) * scale
    }
    let travel = held.travel + Math.hypot(next.x - held.point.x, next.y - held.point.y)
    if (travel >= HAPTIC_STEP) {
      // macOS plays this on Force Touch trackpads; elsewhere it's a no-op.
      ipc.invoke('haptics:detent').catch(() => {})
      travel %= HAPTIC_STEP
    }
    drag.current = { ...held, ...cursor, point: next, travel }
    change(padPointMix(next), false)
  }
  return (
    <>
      <div
        ref={pad}
        role="application"
        aria-roledescription={t('editor.mixPad')}
        aria-label={t('editor.mixPad')}
        aria-describedby={description}
        aria-disabled={disabled || undefined}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Delete Backspace Enter"
        tabIndex={disabled ? -1 : 0}
        className={cn(
          'mix-pad relative aspect-[20/17] w-full touch-none select-none rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/60',
          disabled && 'opacity-40'
        )}
        style={{ '--mix-color': mixLight(value), '--glow': glow } as React.CSSProperties}
        onPointerDown={(event) => {
          if (
            disabled ||
            drag.current ||
            event.button !== 0 ||
            (appInfo.platform === 'darwin' && event.ctrlKey)
          )
            return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          const cursor = point(event)
          const onPoint = (event.target as Element).closest('[data-mix-point]')
          const start = onPoint || event.altKey ? position : cursor
          drag.current = { pointer: event.pointerId, ...cursor, point: start, travel: 0 }
          event.currentTarget.dataset.dragging = ''
          if (!onPoint && !event.altKey) change(padPointMix(cursor), false)
        }}
        onDoubleClick={(event) => {
          if (disabled) return
          const cursor = point(event)
          if (Math.hypot(cursor.x - position.x, cursor.y - position.y) <= HANDLE) {
            event.preventDefault()
            reset()
          }
        }}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          event.currentTarget.style.setProperty('--light-x', `${event.clientX - box.left}px`)
          event.currentTarget.style.setProperty('--light-y', `${event.clientY - box.top}px`)
          follow(event)
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointer !== event.pointerId) return
          follow(event)
          end()
          event.currentTarget.releasePointerCapture(event.pointerId)
          event.currentTarget.blur()
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointer === event.pointerId) end()
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointer === event.pointerId) end()
        }}
        onBlur={end}
        onKeyDown={(event) => {
          if (disabled || drag.current || event.metaKey || event.ctrlKey) return
          blurOnEnter(event)
          if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault()
            reset()
            return
          }
          const direction = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, 1],
            ArrowDown: [0, -1]
          }[event.key]
          if (!direction) return
          event.preventDefault()
          const step = event.altKey ? 0.001 : event.shiftKey ? 0.1 : 0.01
          change(
            pointMix({
              x: mixPoint(value).x + direction[0] * step * Math.sqrt(3),
              y: mixPoint(value).y + direction[1] * step * 1.5
            }),
            true
          )
        }}
      >
        <div aria-hidden="true" className="mix-light" />
        <svg
          className="relative h-full w-full overflow-visible [clip-path:inset(0_round_0.75rem)]"
          viewBox="-8 -6.3 16 13.6"
          role="img"
          aria-label={labels
            .map(({ text }, index) => `${text}: ${t(`editor.source${layers[index]}`)}`)
            .join(', ')}
        >
          {GRID_LAYER}
          {/* Each label is a rounded tag with its letter cut out of it. */}
          {labels.map(({ text, x, y }, index) => (
            <g key={layers[index]}>
              <title>{t(`editor.source${layers[index]}`)}</title>
              <mask
                id={`${cutout}-${index}`}
                maskUnits="userSpaceOnUse"
                x={x - 1.1}
                y={y - 0.6}
                width="2.2"
                height="1.2"
              >
                <rect x={x - 0.8} y={y - 0.45} width="1.6" height="0.9" rx="0.25" fill="white" />
                <text
                  x={x}
                  y={y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="font-mono font-bold"
                  fontSize="0.6"
                  fill="black"
                >
                  {text}
                </text>
              </mask>
              <rect
                x={x - 0.8}
                y={y - 0.45}
                width="1.6"
                height="0.9"
                rx="0.25"
                className="fill-tone-400"
                mask={`url(#${cutout}-${index})`}
              />
            </g>
          ))}
          <g data-mix-point="" transform={`translate(${handle.x},${-handle.y})`}>
            <circle r={HANDLE} fill="transparent" />
            <g className="mix-dot">
              <circle
                r="0.18"
                className="fill-tone-950 stroke-ink"
                vectorEffect="non-scaling-stroke"
                strokeWidth="1.5"
              />
            </g>
          </g>
        </svg>
      </div>
      <p id={description} className="sr-only">
        {t('editor.mixPadHelp')}
        <span>
          {value
            .map((v, i) => `${t(`editor.source${layers[i]}`)} ${(v * 100).toFixed(2)}%`)
            .join(', ')}
        </span>
      </p>
    </>
  )
}
