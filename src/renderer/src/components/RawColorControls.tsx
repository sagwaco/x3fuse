import { useContext, useEffect, useId, useRef, useState } from 'react'
import { Pipette, RotateCcw } from 'lucide-react'
import {
  AEROCHROME_MATRIX,
  IDENTITY_RAW_MATRIX,
  MONOCHROME_RAW_MATRIX,
  RAW_GAIN_RANGE,
  monochromeRawMatrix,
  type EditRecipe
} from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { useQueueStore } from '../stores/queueStore'
import { DevelopingCloud } from '../lib/developingCloud'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { Select } from './ui/select'
import { Adjustment, CHANNELS, SLIDER_LABEL, Swatches, TEMPERATURE, TINT } from './EditorControls'
import { TernaryMixPad } from './TernaryMixPad'
import { useSwitchTween } from '../lib/switchTween'
import { channelMap, swapChannel, type LayerMix } from '../lib/ternaryMix'
import { cn } from '../lib/cn'

const channels = ['red', 'green', 'blue'] as const
const layers = ['Bottom', 'Middle', 'Top'] as const
const MIX_PRESETS = [
  ['identityMix', IDENTITY_RAW_MATRIX],
  ['aerochromeMix', AEROCHROME_MATRIX]
] as const
const everyRow = (mix: number[]): number[] => [0, 1, 2].flatMap(() => mix)
/** Presets of a monochrome mix, which every output row shares. */
const MONOCHROME_MIX_PRESETS = [
  ['sourceBottom', everyRow([1, 0, 0])],
  ['sourceMiddle', everyRow([0, 1, 0])],
  ['sourceTop', everyRow([0, 0, 1])],
  ['equalMix', MONOCHROME_RAW_MATRIX]
] as const

function normalizedGains(gains: [number, number, number]): [number, number, number] {
  return [gains[0] / gains[1], 1, gains[2] / gains[1]]
}

export function GainWhiteBalance({
  gains: storedGains,
  asShot,
  disabled,
  change,
  commit
}: {
  gains: [number, number, number]
  asShot: [number, number, number]
  disabled: boolean
  change: (gains: [number, number, number], save: boolean) => void
  commit: () => void
}): React.JSX.Element {
  const gains = normalizedGains(storedGains)
  const temperature = gains ? Math.log2(gains[0] / gains[2]) / 2 : 0
  const tint = gains ? Math.log2(gains[0] * gains[2]) / 2 : 0
  const green = Math.log2(storedGains[1])
  const [lo, hi] = RAW_GAIN_RANGE.map(Math.log2)
  const setBalance = (axis: 'temperature' | 'tint', value: number, save = true): void => {
    let nextTemperature = temperature
    let nextTint = tint
    // Limit the edited axis so the other balance value does not move.
    if (axis === 'temperature') {
      const limit = Math.min(hi - green - tint, green + tint - lo)
      nextTemperature = Math.max(-limit, Math.min(limit, value))
    } else {
      nextTint = Math.max(
        lo + Math.abs(temperature) - green,
        Math.min(hi - Math.abs(temperature) - green, value)
      )
    }
    const gain = (stops: number): number =>
      Math.max(RAW_GAIN_RANGE[0], Math.min(RAW_GAIN_RANGE[1], 2 ** stops))
    change(
      [
        gain(green + nextTint + nextTemperature),
        storedGains[1],
        gain(green + nextTint - nextTemperature)
      ],
      save
    )
  }
  return (
    <>
      <Adjustment
        label={t('editor.rawTemperature')}
        value={temperature}
        min={lo}
        max={hi}
        step={0.01}
        unit="EV"
        track={TEMPERATURE}
        change={(value, save) => setBalance('temperature', value, save)}
        reset={() =>
          asShot &&
          setBalance('temperature', Math.log2(asShot[0] / asShot[2]) / 2)
        }
        commit={commit}
        disabled={disabled}
      />
      <Adjustment
        label={t('editor.tint')}
        value={tint}
        // The limits stay on the step grid, so the slider can return to 0.
        min={Math.floor((lo - green) * 100) / 100}
        max={Math.ceil((hi - green) * 100) / 100}
        step={0.01}
        unit="EV"
        track={TINT}
        change={(value, save) => setBalance('tint', value, save)}
        reset={() =>
          asShot && setBalance('tint', Math.log2(asShot[0] * asShot[2]) / 2)
        }
        commit={commit}
        disabled={disabled}
      />
    </>
  )
}

/** The matrix of the RAW channel controls, with the state that allows edits. */
function useRawMatrix(recipe: EditRecipe): {
  matrix: number[]
  disabled: boolean
  update: (next: number[], save?: boolean) => void
  commit: () => void
} {
  const asShotGains = useEditorStore((state) => state.preview?.asShotGains)
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const unavailable = useEditorStore(
    (state) => state.before || state.loading || state.closing || !state.preview
  )
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const cloud = useContext(DevelopingCloud)
  const gains = recipe.rawColor?.gains ?? (asShotGains && normalizedGains(asShotGains))
  return {
    matrix: recipe.rawColor?.matrix ?? IDENTITY_RAW_MATRIX,
    disabled: !gains || unavailable || busy || cloud,
    update: (next, save = true) => {
      if (gains) change({ rawColor: { gains: [...gains], matrix: next } }, save)
    },
    commit
  }
}

export function RawMatrixControls({
  recipe,
  mixPicking,
  setMixPicking
}: {
  recipe: EditRecipe
  mixPicking?: 0 | 1 | 2 | null
  setMixPicking?: (output: 0 | 1 | 2 | null) => void
}): React.JSX.Element {
  const [output, setOutput] = useState<(typeof channels)[number]>('red')
  const { matrix, disabled, update: updateMatrix, commit } = useRawMatrix(recipe)
  // A monochrome mix has one row for all outputs, so edits keep the image monochrome.
  const monochrome = monochromeRawMatrix(matrix)
  const row = monochrome ? 0 : channels.indexOf(output)
  const base = monochrome ? MONOCHROME_RAW_MATRIX : IDENTITY_RAW_MATRIX
  const update = (next: number[], save = true): void =>
    updateMatrix(monochrome ? [0, 1, 2].flatMap(() => next.slice(0, 3)) : next, save)
  const session = useEditorStore((state) => state.session?.sessionId)
  const mix = matrix.slice(row * 3, row * 3 + 3) as LayerMix
  // On a channel switch, the pad handle and the sliders glide from the previous mix.
  const { from, t: glide } = useSwitchTween(output, mix)
  const shown = glide === 1 ? mix : (mix.map((v, i) => from[i] + (v - from[i]) * glide) as LayerMix)
  const setSource = (column: number, value: number, save = true): void => {
    const next = [...matrix]
    const others = [0, 1, 2].filter((index) => index !== column)
    const first = row * 3 + others[0]
    const second = row * 3 + others[1]
    const remaining = 1 - value
    const state = useEditorStore.getState()
    // Keep the source ratio when a drag passes through 100% or a coefficient limit.
    const source =
      (state.session && state.documents[state.session.path]?.gesture?.rawColor?.matrix) || matrix
    const sum = source[first] + source[second]
    const proportional = Math.abs(sum) < 1e-8 ? remaining / 2 : (remaining * source[first]) / sum
    // Limit redistribution so both source coefficients stay in the supported range.
    next[first] = Math.max(-4, remaining - 4, Math.min(4, remaining + 4, proportional))
    next[second] = remaining - next[first]
    next[row * 3 + column] = value
    update(next, save)
  }
  const presets: readonly (readonly [string, readonly number[]])[] = monochrome
    ? MONOCHROME_MIX_PRESETS
    : MIX_PRESETS
  const preset =
    presets.find(([, preset]) =>
      // The backend stores f32 values.
      preset.every((value, index) => Math.abs(value - matrix[index]) < 1e-6)
    )?.[0] ?? 'custom'
  const reset = (): void => {
    const next = [...matrix]
    next.splice(row * 3, 3, ...base.slice(row * 3, row * 3 + 3))
    update(next)
  }
  return (
    <>
      <div className="tool-row flex flex-wrap items-center gap-2">
        {!monochrome && (
          <Swatches
            label={t('editor.outputChannel')}
            value={output}
            options={channels.map((channel) => ({
              value: channel,
              label: t(`editor.${channel}`),
              color: CHANNELS[channel]
            }))}
            onChange={(next) => {
              setMixPicking?.(null)
              commit()
              setOutput(next)
            }}
          />
        )}
        <Select
          aria-label={t('editor.rawMixPreset')}
          // Without the channel swatches, the select stays on the row of the buttons.
          className={cn(!monochrome && 'tool-row-select', 'min-w-0 flex-1')}
          value={preset}
          disabled={disabled}
          options={[
            ...presets.map(([value]) => ({ value, label: t(`editor.${value}`) })),
            ...(preset === 'custom'
              ? [{ value: 'custom', label: t('editor.customWhiteBalance'), disabled: true }]
              : [])
          ]}
          onValueChange={(value) => {
            const selected = presets.find(([name]) => name === value)
            if (selected) update([...selected[1]])
          }}
        />
        <div className="ml-auto flex gap-1">
          {setMixPicking && !monochrome && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={t('editor.mixQualifier', { color: t(`editor.${output}`) })}
              title={t('editor.mixQualifierHelp', { color: t(`editor.${output}`) })}
              aria-pressed={mixPicking === row}
              disabled={disabled}
              onClick={() => setMixPicking(mixPicking === row ? null : (row as 0 | 1 | 2))}
            >
              <Pipette aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('editor.resetOutputMix')}
            title={t('editor.resetOutputMix')}
            disabled={disabled}
            onClick={reset}
          >
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <TernaryMixPad
        key={session}
        value={mix}
        shown={shown}
        disabled={disabled}
        change={(mix, save) => {
          const next = [...matrix]
          next.splice(row * 3, 3, ...mix)
          update(next, save)
        }}
        commit={commit}
        reset={reset}
        glow={CHANNELS[output]}
      />
      {mixPicking === row && (
        <p role="status" className="text-xs text-tone-200">
          {t('editor.mixQualifierHint', { color: t(`editor.${output}`) })}
        </p>
      )}
      <div>
        {/* Top to bottom, as the layers stack in the sensor. */}
        {[2, 1, 0].map((column) => (
          <Adjustment
            key={`${session}:${output}:${layers[column]}`}
            label={t(`editor.source${layers[column]}`)}
            short={layers[column][0]}
            value={Number((shown[column] * 100).toFixed(4))}
            min={-400}
            max={400}
            step={1}
            change={(value, save) => setSource(column, value / 100, save)}
            reset={() => setSource(column, base[row * 3 + column])}
            commit={commit}
            disabled={disabled}
          />
        ))}
      </div>
    </>
  )
}

const NODE_Y = [10, 30, 50]
const INPUT_X = 5
const OUTPUT_X = 135

/**
 * A link from an input to `end`. It eases from `from` when it mounts, and to each new
 * `end` unless `follow` is set.
 */
function SwapLink({
  input,
  from: initial,
  end,
  stroke,
  dotted = false,
  follow = false
}: {
  input: number
  from?: { x: number; y: number }
  end: { x: number; y: number }
  stroke: string
  dotted?: boolean
  follow?: boolean
}): React.JSX.Element {
  const [shown, setShown] = useState(initial ?? end)
  const current = useRef(initial ?? end)
  useEffect(() => {
    const from = current.current
    const show = (point: { x: number; y: number }): void => {
      current.current = point
      setShown(point)
    }
    if (
      follow ||
      (from.x === end.x && from.y === end.y) ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    )
      return show(end)
    const start = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - start) / 180)
      const eased = 1 - (1 - progress) ** 3
      show({ x: from.x + (end.x - from.x) * eased, y: from.y + (end.y - from.y) * eased })
      if (progress < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [end.x, end.y, follow]) // eslint-disable-line react-hooks/exhaustive-deps
  const y = NODE_Y[input]
  return (
    <path
      d={`M ${INPUT_X} ${y} C 70 ${y}, 70 ${shown.y}, ${shown.x} ${shown.y}`}
      fill="none"
      stroke={stroke}
      strokeWidth="1.25"
      strokeDasharray={dotted ? '2 2' : undefined}
      className={dotted ? 'marching-dash' : undefined}
    />
  )
}

/** The output under a drag point, or -1. */
const dropTarget = ({ x, y }: { x: number; y: number }): number =>
  x > 70 ? NODE_Y.findIndex((node) => Math.abs(node - y) < 10) : -1

export function ChannelSwap({ recipe }: { recipe: EditRecipe }): React.JSX.Element {
  const { matrix, disabled, update } = useRawMatrix(recipe)
  const map = channelMap(matrix)
  // SVG url() references need a plain id.
  const gradient = useId().replace(/[^\w-]/g, '')
  // A drag from either end of a link moves its input to the output under the release point.
  const [drag, setDrag] = useState<{ pointer: number; input: number; x: number; y: number }>()
  const move = (input: number, output: number): void => {
    if (map[output] !== input) update(swapChannel(matrix, input, output))
  }
  const point = (event: React.PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const box = event.currentTarget.getBoundingClientRect()
    return {
      x: ((event.clientX - box.left) / box.width) * 140,
      y: ((event.clientY - box.top) / box.height) * 60
    }
  }
  const name = (channel: number): string => t(`editor.${channels[channel]}`)
  const labels = (align: string): React.JSX.Element => (
    <div aria-hidden="true" className={cn('grid grid-rows-3 items-center', align, SLIDER_LABEL)}>
      {channels.map((channel) => (
        <span key={channel}>{channel[0].toUpperCase()}</span>
      ))}
    </div>
  )
  const link = (input: number, output: number): React.JSX.Element => (
    <SwapLink
      input={input}
      end={{ x: OUTPUT_X, y: NODE_Y[output] }}
      stroke={`url(#${gradient}${input}${output})`}
    />
  )
  // While a drag is over an output, the link snaps to it, and the input it displaces
  // shows with a dotted line at the dragged input's present output.
  const target = drag ? dropTarget(drag) : -1
  const displaced = target >= 0 && map[target] !== drag?.input ? map[target] : -1
  return (
    <div className="grid grid-cols-[1rem_minmax(0,1fr)_1rem]">
      {labels('text-left')}
      <svg
        viewBox="0 0 140 60"
        role="group"
        aria-label={t('editor.channelSwap')}
        className={cn(
          'aspect-[7/3] w-full touch-none select-none overflow-visible',
          drag && 'cursor-grabbing [&_*]:cursor-grabbing',
          disabled && 'opacity-40'
        )}
        onPointerDown={(event) => {
          const node = (event.target as Element).closest('[data-input],[data-output]')
          if (disabled || drag || !node || event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          const input = node.hasAttribute('data-input')
            ? Number(node.getAttribute('data-input'))
            : map[Number(node.getAttribute('data-output'))]
          setDrag({ pointer: event.pointerId, input, ...point(event) })
        }}
        onPointerMove={(event) => {
          if (drag?.pointer === event.pointerId) setDrag({ ...drag, ...point(event) })
        }}
        onPointerUp={(event) => {
          if (drag?.pointer !== event.pointerId) return
          const output = dropTarget(point(event))
          if (output >= 0) move(drag.input, output)
          setDrag(undefined)
        }}
        onPointerCancel={() => setDrag(undefined)}
        onLostPointerCapture={() => setDrag(undefined)}
      >
        <defs>
          {map.flatMap((_, input) =>
            map.map((_, output) => (
              <linearGradient
                key={`${input}${output}`}
                id={`${gradient}${input}${output}`}
                gradientUnits="userSpaceOnUse"
                x1={INPUT_X}
                x2={OUTPUT_X}
                y1="0"
                y2="0"
              >
                <stop offset="0" stopColor={CHANNELS[channels[input]]} />
                <stop offset="1" stopColor={CHANNELS[channels[output]]} />
              </linearGradient>
            ))
          )}
        </defs>
        {map.map((input, output) =>
          input === displaced || (input === drag?.input && target >= 0) ? null : (
            <g key={input} opacity={input === drag?.input ? 0.25 : 1}>
              {link(input, output)}
            </g>
          )
        )}
        {/* The uncommitted links are dotted. The dragged one follows the cursor, then
            eases onto an output under it. */}
        {drag && (
          <SwapLink
            input={drag.input}
            end={target >= 0 ? { x: OUTPUT_X, y: NODE_Y[target] } : drag}
            stroke={
              target >= 0
                ? `url(#${gradient}${drag.input}${target})`
                : CHANNELS[channels[drag.input]]
            }
            dotted
            follow={target < 0}
          />
        )}
        {displaced >= 0 && (
          <SwapLink
            input={displaced}
            from={{ x: OUTPUT_X, y: NODE_Y[target] }}
            end={{ x: OUTPUT_X, y: NODE_Y[map.indexOf(drag!.input)] }}
            stroke={`url(#${gradient}${displaced}${map.indexOf(drag!.input)})`}
            dotted
          />
        )}
        {channels.map((channel, index) => (
          <g key={channel}>
            <g
              data-input={index}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-label={t('editor.channelSwapInput', {
                input: name(index),
                output: name(map.indexOf(index))
              })}
              aria-disabled={disabled || undefined}
              aria-keyshortcuts="ArrowUp ArrowDown"
              className="group/input cursor-grab outline-none [&:focus-visible>circle]:stroke-ink"
              onKeyDown={(event) => {
                const step = { ArrowUp: -1, ArrowDown: 1 }[event.key]
                if (disabled || !step) return
                event.preventDefault()
                move(index, (map.indexOf(index) + step + 3) % 3)
              }}
            >
              <circle cx={INPUT_X} cy={NODE_Y[index]} r="8" fill="transparent" />
              <circle
                cx={INPUT_X}
                cy={NODE_Y[index]}
                r="4.5"
                fill={CHANNELS[channel]}
                strokeWidth="1.5"
                className={cn(
                  'origin-center stroke-transparent transition-transform duration-150 [transform-box:fill-box]',
                  drag?.input === index
                    ? 'scale-100'
                    : cn('scale-[0.6]', !disabled && !drag && 'group-hover/input:scale-100')
                )}
              />
            </g>
            <g data-output={index} className="group/output cursor-grab">
              <circle cx={OUTPUT_X} cy={NODE_Y[index]} r="8" fill="transparent" />
              {/* The knob is small until a pointer is on it or a drag targets it. */}
              <circle
                cx={OUTPUT_X}
                cy={NODE_Y[index]}
                r="4.5"
                fill={CHANNELS[channel]}
                className={cn(
                  'origin-center transition-transform duration-150 [transform-box:fill-box]',
                  target === index
                    ? 'scale-100'
                    : cn('scale-[0.6]', !disabled && !drag && 'group-hover/output:scale-100')
                )}
              />
              {target === index && (
                <circle
                  cx={OUTPUT_X}
                  cy={NODE_Y[index]}
                  r="7"
                  fill="none"
                  stroke={CHANNELS[channel]}
                  strokeWidth="1"
                  strokeDasharray="2 2"
                  className="marching-dash"
                />
              )}
            </g>
          </g>
        ))}
      </svg>
      {labels('text-right')}
    </div>
  )
}
