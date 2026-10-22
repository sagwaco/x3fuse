import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type MouseEvent,
  type PointerEvent
} from 'react'
import {
  MIX_BOUNDARY,
  mixPoint,
  pointMix,
  mixPadPoint,
  padPointMix,
  type LayerMix
} from '../lib/ternaryMix'
import { appInfo } from '../lib/appInfo'
import { blurOnEnter } from '../lib/commitFocus'
import { cn } from '../lib/cn'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { RotateCcw } from 'lucide-react'

const layers = ['Bottom', 'Middle', 'Top'] as const
const vertices: LayerMix[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
]
const polygon = (points: { x: number; y: number }[]): string =>
  points.map(({ x, y }) => `${x},${-y}`).join(' ')

export function TernaryMixPad({
  value,
  disabled,
  change,
  commit,
  reset,
  qualifier
}: {
  value: LayerMix
  disabled: boolean
  change: (value: LayerMix, save: boolean) => void
  commit: () => void
  reset: () => void
  qualifier?: ReactNode
}): React.JSX.Element {
  const description = useId()
  const drag = useRef<{
    pointer: number
    x: number
    y: number
    point: { x: number; y: number }
  } | null>(null)
  const end = useCallback(() => {
    if (!drag.current) return
    drag.current = null
    commit()
  }, [commit])
  useEffect(() => end, [disabled, end])
  const position = mixPadPoint(value)
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
    drag.current = { ...held, ...cursor, point: next }
    change(padPointMix(next), false)
  }
  return (
    <>
      <div className="mb-1 flex items-center justify-between text-xs text-tone-400">
        <span>{t('editor.mixPad')}</span>
        <div className="flex items-center gap-1">
          {qualifier}
          <Button
            size="icon"
            className="h-6 w-6"
            aria-label={t('editor.resetOutputMix')}
            title={t('editor.resetOutputMix')}
            disabled={disabled}
            onClick={reset}
          >
            <RotateCcw aria-hidden="true" className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <div
        role="application"
        aria-roledescription={t('editor.mixPad')}
        aria-label={t('editor.mixPad')}
        aria-describedby={description}
        aria-disabled={disabled || undefined}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown Delete Backspace Enter"
        tabIndex={disabled ? -1 : 0}
        className={cn(
          'relative aspect-[20/17] w-full touch-none select-none rounded-lg border border-ink/15 bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/60',
          disabled && 'opacity-40'
        )}
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
          drag.current = { pointer: event.pointerId, ...cursor, point: start }
          if (!onPoint && !event.altKey) change(padPointMix(cursor), false)
        }}
        onDoubleClick={(event) => {
          if (disabled) return
          const cursor = point(event)
          if (Math.hypot(cursor.x - position.x, cursor.y - position.y) <= 0.6) {
            event.preventDefault()
            reset()
          }
        }}
        onPointerMove={follow}
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
        <svg
          className="h-full w-full overflow-visible"
          viewBox="-8 -6.3 16 13.6"
          role="img"
          aria-label={layers
            .map((layer) => `${layer[0]}: ${t(`editor.source${layer}`)}`)
            .join(', ')}
        >
          <polygon
            points={polygon(MIX_BOUNDARY)}
            fill="none"
            className="stroke-ink/20"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1"
          />
          {(
            [
              [
                [0, -3, 4],
                [0, 4, -3]
              ],
              [
                [-3, 0, 4],
                [4, 0, -3]
              ],
              [
                [-3, 4, 0],
                [4, -3, 0]
              ]
            ] as [LayerMix, LayerMix][]
          ).map(([start, end], index) => (
            <polyline
              key={index}
              points={polygon(
                Array.from({ length: 57 }, (_, step) =>
                  mixPadPoint(start.map((v, i) => v + ((end[i] - v) * step) / 56) as LayerMix)
                )
              )}
              className="stroke-ink/20"
              fill="none"
              vectorEffect="non-scaling-stroke"
              strokeWidth="1"
              strokeDasharray="3 4"
            />
          ))}
          <polygon
            points={polygon(vertices.map(mixPadPoint))}
            className="fill-ink/10 stroke-ink/70"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1.2"
          />
          <path
            d="M -0.15 0 H 0.15 M 0 -0.15 V 0.15"
            className="stroke-ink/40"
            vectorEffect="non-scaling-stroke"
            strokeWidth="1"
          />
          {vertices.map((mix, index) => {
            const p = mixPadPoint(mix)
            const labels = [
              { x: 0, y: -4.1 },
              { x: -3.75, y: 2.15 },
              { x: 3.75, y: 2.15 }
            ]
            return (
              <g key={layers[index]}>
                <circle cx={p.x} cy={-p.y} r="0.09" className="fill-ink/70" />
                <text
                  x={labels[index].x}
                  y={labels[index].y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="fill-tone-200"
                  fontSize="0.7"
                >
                  <title>{t(`editor.source${layers[index]}`)}</title>
                  {layers[index][0]}
                </text>
              </g>
            )
          })}
          <g data-mix-point="" transform={`translate(${position.x},${-position.y})`}>
            <circle r="0.6" fill="transparent" />
            <circle
              r="0.25"
              className="fill-tone-950 stroke-ink"
              vectorEffect="non-scaling-stroke"
              strokeWidth="1.5"
            />
            <circle r="0.07" className="fill-ink" />
          </g>
        </svg>
      </div>
      <p id={description} className="text-[11px] leading-relaxed text-tone-500">
        {t('editor.mixPadHelp')}
        <span className="sr-only">
          {value
            .map((v, i) => `${t(`editor.source${layers[i]}`)} ${(v * 100).toFixed(2)}%`)
            .join(', ')}
        </span>
      </p>
    </>
  )
}
