import { useContext, useState } from 'react'
import { Pipette, RotateCcw } from 'lucide-react'
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
import { withShortcut } from '../lib/shortcut'
import { Button } from './ui/button'
import { GlassGroup } from './ui/glassGroup'
import { Adjustment } from './EditorControls'

const gainScale = { to: Math.log2, from: (value: number): number => 2 ** value, step: 1 / 24 }
const channels = ['red', 'green', 'blue'] as const
const layers = ['Bottom', 'Middle', 'Top'] as const

function normalizedGains(gains: [number, number, number]): [number, number, number] {
  return [gains[0] / gains[1], 1, gains[2] / gains[1]]
}

function rawGain(value: number, middle: number): number {
  return Math.max(RAW_GAIN_RANGE[0], Math.min(RAW_GAIN_RANGE[1], value * middle))
}

export function RawWhiteBalance({
  recipe,
  picking,
  setPicking
}: {
  recipe: EditRecipe
  picking: boolean
  setPicking: (value: boolean) => void
}): React.JSX.Element {
  const asShotGains = useEditorStore((state) => state.preview?.asShotGains)
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const unavailable = useEditorStore(
    (state) => state.before || state.loading || state.closing || !state.preview
  )
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const cloud = useContext(DevelopingCloud)
  const asShot = asShotGains && normalizedGains(asShotGains)
  const gains = recipe.rawColor?.gains ? normalizedGains(recipe.rawColor.gains) : asShot
  const storedGains = recipe.rawColor?.gains ?? asShot
  const matrix = recipe.rawColor?.matrix ?? IDENTITY_RAW_MATRIX
  const setGain = (channel: 0 | 2, value: number, save = true): void => {
    if (!storedGains) return
    const next: [number, number, number] = [...storedGains]
    next[channel] = rawGain(value, next[1])
    change({ rawColor: { gains: next, matrix: [...matrix] } }, save)
  }
  const reset = (): void => {
    if (asShot) change({ rawColor: { gains: asShot, matrix: [...matrix] } })
  }
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Button
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t('editor.picker')}
          title={withShortcut(t('editor.picker'), 'whiteBalancePicker')}
          aria-keyshortcuts="W"
          aria-pressed={picking}
          disabled={!asShot || unavailable || busy || cloud}
          onClick={() => setPicking(!picking)}
        >
          <Pipette aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          className="ml-auto"
          aria-label={t('editor.resetWhiteBalance')}
          disabled={
            !asShot ||
            unavailable ||
            busy ||
            cloud ||
            (gains?.[0] === asShot[0] && gains?.[2] === asShot[2])
          }
          onClick={reset}
        >
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          {t('editor.asShot')}
        </Button>
      </div>
      {picking && (
        <p role="status" className="control-label text-tone-100">
          {t('editor.pickNeutral')}
        </p>
      )}
      {([0, 2] as const).map((channel) => (
        <Adjustment
          key={channel}
          label={t(channel === 0 ? 'editor.redGain' : 'editor.blueGain')}
          value={gains ? Number(gains[channel].toFixed(4)) : 1}
          min={RAW_GAIN_RANGE[0]}
          max={RAW_GAIN_RANGE[1]}
          step={0.0001}
          scale={gainScale}
          change={(value, save) => setGain(channel, value, save)}
          reset={() => asShot && setGain(channel, asShot[channel])}
          commit={commit}
          disabled={asShot ? undefined : true}
        />
      ))}
      <p className="text-xs text-tone-500">{t('editor.greenGain')}: 1</p>
    </>
  )
}

export function RawMatrixControls({ recipe }: { recipe: EditRecipe }): React.JSX.Element {
  const [output, setOutput] = useState<(typeof channels)[number]>('red')
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
        onValueChange={setOutput}
        items={channels.map((channel) => ({
          value: channel,
          label: t(`editor.output${channel[0].toUpperCase()}${channel.slice(1)}`)
        }))}
        className="grid auto-cols-fr grid-flow-col"
      />
      <div role="tabpanel" id="raw-output-panel" aria-labelledby={`raw-output-tab-${output}`}>
        {channels.map((channel, column) => (
          <Adjustment
            key={channel}
            label={t(`editor.source${layers[column]}`)}
            short={layers[column][0]}
            value={Number((matrix[row * 3 + column] * 100).toFixed(4))}
            min={-400}
            max={400}
            step={1}
            change={(value, save) => setSource(column, value / 100, save)}
            reset={() => setSource(column, IDENTITY_RAW_MATRIX[row * 3 + column])}
            commit={commit}
            disabled={gains ? undefined : true}
          />
        ))}
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
