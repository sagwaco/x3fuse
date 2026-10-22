import { useContext, useEffect, useRef, useState } from 'react'
import { Pipette } from 'lucide-react'
import {
  AEROCHROME_MATRIX,
  IDENTITY_RAW_MATRIX,
  RAW_GAIN_RANGE,
  type EditRecipe
} from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { useQueueStore } from '../stores/queueStore'
import { DevelopingCloud } from '../lib/developingCloud'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { GlassGroup } from './ui/glassGroup'
import { Adjustment, TEMPERATURE, TINT } from './EditorControls'
import { TernaryMixPad } from './TernaryMixPad'
import type { LayerMix } from '../lib/ternaryMix'
import { blurOnEnter } from '../lib/commitFocus'

const channels = ['red', 'green', 'blue'] as const
const layers = ['Bottom', 'Middle', 'Top'] as const
const BALANCE_SCALE = 100 / Math.log2(RAW_GAIN_RANGE[1])

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
      nextTemperature = Math.max(-limit, Math.min(limit, value / BALANCE_SCALE))
    } else {
      nextTint = Math.max(
        lo + Math.abs(temperature) - green,
        Math.min(hi - Math.abs(temperature) - green, value / BALANCE_SCALE)
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
        value={temperature * BALANCE_SCALE}
        track={TEMPERATURE}
        change={(value, save) => setBalance('temperature', value, save)}
        reset={() =>
          asShot &&
          setBalance('temperature', (Math.log2(asShot[0] / asShot[2]) * BALANCE_SCALE) / 2)
        }
        commit={commit}
        disabled={disabled}
      />
      <Adjustment
        label={t('editor.tint')}
        value={tint * BALANCE_SCALE}
        min={Math.floor((lo - green) * BALANCE_SCALE)}
        max={Math.ceil((hi - green) * BALANCE_SCALE)}
        track={TINT}
        change={(value, save) => setBalance('tint', value, save)}
        reset={() =>
          asShot && setBalance('tint', (Math.log2(asShot[0] * asShot[2]) * BALANCE_SCALE) / 2)
        }
        commit={commit}
        disabled={disabled}
      />
    </>
  )
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
  const [view, setView] = useState<'pad' | 'sliders'>('pad')
  const asShotGains = useEditorStore((state) => state.preview?.asShotGains)
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const unavailable = useEditorStore(
    (state) => state.before || state.loading || state.closing || !state.preview
  )
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const cloud = useContext(DevelopingCloud)
  const gains = recipe.rawColor?.gains ?? (asShotGains && normalizedGains(asShotGains))
  const disabled = !gains || unavailable || busy || cloud
  const matrix = recipe.rawColor?.matrix ?? IDENTITY_RAW_MATRIX
  const row = channels.indexOf(output)
  const session = useEditorStore((state) => state.session?.sessionId)
  const total = Number(
    (matrix.slice(row * 3, row * 3 + 3).reduce((sum, value) => sum + value, 0) * 100).toFixed(4)
  )
  const update = (next: number[], save = true): void => {
    if (gains) change({ rawColor: { gains: [...gains], matrix: next } }, save)
  }
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
  const swap = (first: number, second: number): void => {
    const next = [...matrix]
    for (let column = 0; column < 3; column++) {
      const index = first * 3 + column
      next[index] = matrix[second * 3 + column]
      next[second * 3 + column] = matrix[index]
    }
    update(next)
  }
  return (
    <>
      <GlassGroup
        kind="tabs"
        id="raw-output"
        panelId={() => 'raw-output-panel'}
        aria-label={t('editor.outputChannel')}
        value={output}
        onValueChange={(next) => {
          setMixPicking?.(null)
          commit()
          setOutput(next)
        }}
        items={channels.map((channel) => ({
          value: channel,
          label: t(`editor.${channel}`),
          title: t(`editor.output${channel[0].toUpperCase()}${channel.slice(1)}`)
        }))}
        className="grid auto-cols-fr grid-flow-col"
      />
      <GlassGroup
        aria-label={t('editor.mixView')}
        size="sm"
        value={view}
        onValueChange={(next) => {
          setMixPicking?.(null)
          commit()
          setView(next)
        }}
        items={[
          { value: 'pad', label: t('editor.mixPadView') },
          { value: 'sliders', label: t('editor.mixSlidersView') }
        ]}
        className="grid auto-cols-fr grid-flow-col"
      />
      <div role="tabpanel" id="raw-output-panel" aria-labelledby={`raw-output-tab-${output}`}>
        {view === 'pad' ? (
          <>
            <TernaryMixPad
              key={`${session}:${output}`}
              value={matrix.slice(row * 3, row * 3 + 3) as LayerMix}
              disabled={disabled}
              qualifier={
                setMixPicking && (
                  <Button
                    size="icon"
                    className="h-6 w-6"
                    aria-label={t('editor.mixQualifier', { color: t(`editor.${output}`) })}
                    title={t('editor.mixQualifierHelp', { color: t(`editor.${output}`) })}
                    aria-pressed={mixPicking === row}
                    disabled={disabled}
                    onClick={() => setMixPicking(mixPicking === row ? null : (row as 0 | 1 | 2))}
                  >
                    <Pipette aria-hidden="true" className="h-3 w-3" />
                  </Button>
                )
              }
              change={(mix, save) => {
                const next = [...matrix]
                next.splice(row * 3, 3, ...mix)
                update(next, save)
              }}
              commit={commit}
              reset={() => {
                const next = [...matrix]
                next.splice(row * 3, 3, ...IDENTITY_RAW_MATRIX.slice(row * 3, row * 3 + 3))
                update(next)
              }}
            />
            {mixPicking === row && (
              <p role="status" className="text-xs text-tone-200">
                {t('editor.mixQualifierHint', { color: t(`editor.${output}`) })}
              </p>
            )}
            <div className="my-2 grid grid-cols-3 gap-2">
              {layers.map((layer, column) => (
                <label
                  key={layer}
                  className="flex min-w-0 items-center gap-1 text-xs text-tone-400"
                  title={t(`editor.source${layer}`)}
                >
                  <span aria-hidden="true">{layer[0]}</span>
                  <MixPercentage
                    key={`${session}:${output}`}
                    label={t(`editor.source${layer}`)}
                    value={matrix[row * 3 + column] * 100}
                    disabled={disabled}
                    change={(value) => setSource(column, value / 100, false)}
                    commit={commit}
                  />
                  <span aria-hidden="true">%</span>
                </label>
              ))}
            </div>
          </>
        ) : (
          layers.map((layer, column) => (
            <Adjustment
              key={`${session}:${output}:${layer}`}
              label={t(`editor.source${layer}`)}
              short={layer[0]}
              value={Number((matrix[row * 3 + column] * 100).toFixed(4))}
              min={-400}
              max={400}
              step={1}
              change={(value, save) => setSource(column, value / 100, save)}
              reset={() => setSource(column, IDENTITY_RAW_MATRIX[row * 3 + column])}
              commit={commit}
              disabled={disabled}
            />
          ))
        )}
        <p className={total === 100 ? 'text-xs text-tone-500' : 'text-xs text-danger'}>
          {t('editor.total')}: {total}%
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            [0, 2],
            [0, 1],
            [1, 2]
          ] as const
        ).map(([first, second]) => (
          <Button
            key={`${first}${second}`}
            size="sm"
            disabled={disabled}
            onClick={() => swap(first, second)}
          >
            {t(
              `editor.swap${channels[first][0].toUpperCase()}${channels[second][0].toUpperCase()}`
            )}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={disabled} onClick={() => update([...IDENTITY_RAW_MATRIX])}>
          {t('editor.identity')}
        </Button>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() =>
            update(Array.from({ length: 3 }, () => matrix.slice(row * 3, row * 3 + 3)).flat())
          }
        >
          {t('editor.monochrome')}
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => update([...AEROCHROME_MATRIX])}>
          {t('editor.aerochrome')}
        </Button>
      </div>
    </>
  )
}

function MixPercentage({
  label,
  value,
  disabled,
  change,
  commit
}: {
  label: string
  value: number
  disabled: boolean
  change: (value: number) => void
  commit: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string>()
  const fresh = useRef(false)
  const editing = useRef(false)
  const finish = (): void => {
    if (!editing.current) return
    editing.current = false
    commit()
  }
  useEffect(() => {
    if (disabled) setDraft(undefined)
    return () => {
      if (!editing.current) return
      editing.current = false
      commit()
    }
  }, [commit, disabled])
  return (
    <input
      aria-label={label}
      type="number"
      min={-400}
      max={400}
      step={0.1}
      disabled={disabled}
      value={draft ?? Number(value.toFixed(4))}
      className="h-7 w-full min-w-0 rounded-md border border-ink/15 bg-transparent px-1 text-right text-xs tabular-nums text-tone-100 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/60 disabled:opacity-40"
      onMouseDown={(event) => {
        fresh.current = document.activeElement !== event.currentTarget
      }}
      onMouseUp={(event) => {
        if (fresh.current) event.preventDefault()
        fresh.current = false
      }}
      onFocus={(event) => {
        setDraft(String(Number(value.toFixed(4))))
        event.currentTarget.select()
      }}
      onKeyDown={blurOnEnter}
      onChange={(event) => {
        setDraft(event.currentTarget.value)
        const next = event.currentTarget.valueAsNumber
        if (Number.isFinite(next)) {
          editing.current = true
          change(Math.max(-400, Math.min(400, next)))
        }
      }}
      onBlur={() => {
        setDraft(undefined)
        finish()
      }}
    />
  )
}
