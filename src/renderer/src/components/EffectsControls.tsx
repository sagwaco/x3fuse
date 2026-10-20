import { useContext } from 'react'
import {
  DEFAULT_EFFECTS,
  DEFAULT_FILM,
  filmGrainDefaults,
  grainRmsBase,
  type EditRecipe,
  type EffectsSettings,
  type FilmSettings
} from '@shared/editor'
import stocks from '@shared/film-stocks.json'
import { useEditorStore } from '../stores/editorStore'
import { DevelopingCloud } from '../lib/developingCloud'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { RotateCcw } from 'lucide-react'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { AdvancedDetails } from './ui/advancedDetails'
import { HelpTooltip } from './ui/settingsLayout'
import { Adjustment, HIDE_WHILE_RESETTING, ResetLabel, Section } from './EditorControls'

/**
 * The Effects section: grain and halation. A film stock stores them in `recipe.film`;
 * a camera matching look stores them in `recipe.effects`.
 */
export function EffectsSection({ recipe }: { recipe: EditRecipe }): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const cloud = useContext(DevelopingCloud)
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const inactive = useEditorStore(
    (state) => state.before || state.loading || state.closing || !state.preview
  )
  const disabled = cloud || busy || inactive
  const film = recipe.film
  const fx = film ?? { ...DEFAULT_EFFECTS, ...recipe.effects }
  const monochrome = !!film && !!stocks.find((s) => !s.isPaper && s.index === film.film)?.monochrome
  const update = (patch: Partial<FilmSettings>, save = true): void =>
    film
      ? change({ film: { ...film, ...patch } }, save)
      : // Only the four effect keys reach this branch.
        change({ effects: { ...fx, ...patch } as EffectsSettings }, save)
  const grainDefaults = film
    ? filmGrainDefaults(film.film)
    : structuredClone(DEFAULT_EFFECTS.grainParams)
  const grain = fx.grainParams
  const halation = fx.halationParams
  const resetGrain = (): void => {
    if (disabled) return
    update(
      film
        ? {
            grainParams: grainDefaults,
            grainSize: DEFAULT_FILM.grainSize,
            grainAmount: DEFAULT_FILM.grainAmount,
            grainRoughness: DEFAULT_FILM.grainRoughness,
            grainSaturation: DEFAULT_FILM.grainSaturation
          }
        : { grainParams: grainDefaults }
    )
  }
  const resetHalation = (): void => {
    if (disabled) return
    update({ halationParams: { ...DEFAULT_FILM.halationParams! } })
  }
  const base = grain ? grainRmsBase(grain, monochrome) : 0
  const offsets =
    grain && !monochrome ? grain.rmsGranularity.map((value) => value - base) : [0, 0, 0]
  const offset = (channel: number, value: number, save = true): void => {
    if (!grain) return
    update(
      {
        grainParams: {
          ...grain,
          rmsBase: base,
          rmsGranularity: grain.rmsGranularity.map((current, index) =>
            index === channel ? Math.max(0, Math.min(100, base + value)) : current
          ) as [number, number, number]
        }
      },
      save
    )
  }
  /** The label resets with Shift-click; its help icon follows it, as in a slider row. */
  const header = (
    effect: 'grain' | 'halation',
    reset: () => void,
    enabled: boolean
  ): React.JSX.Element => {
    const resetLabel = t(effect === 'grain' ? 'editor.resetGrain' : 'editor.resetHalation')
    return (
      <div className="group/reset flex items-center justify-between gap-3 pt-2 [&+.adjustment]:!mt-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <ResetLabel label={t(`editor.${effect}`)} disabled={disabled} reset={reset} />
          <HelpTooltip
            label={t(`editor.${effect}`)}
            text={t(film ? `editor.${effect}Help` : `editor.${effect}LookHelp`)}
            className={HIDE_WHILE_RESETTING}
          />
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={resetLabel}
            title={resetLabel}
            disabled={disabled}
            onClick={reset}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Switch
            aria-label={t(`editor.${effect}`)}
            checked={fx[effect]}
            disabled={disabled || !enabled}
            onCheckedChange={(on) => update({ [effect]: on })}
          />
        </div>
      </div>
    )
  }
  return (
    <Section id="effects" name={t('editor.effects')}>
      {header('grain', resetGrain, !!grain)}
      {!grain && <p className="text-xs text-tone-400">{t('editor.legacyFilmEffect')}</p>}
      {grain && fx.grain && (
        <>
          <Adjustment
            label={t('editor.grainRmsGranularity')}
            help={t('editor.grainRmsGranularityHelp')}
            value={base}
            min={Math.max(0, -Math.min(...offsets))}
            max={Math.min(100, 100 - Math.max(...offsets))}
            step={0.5}
            change={(value, save) =>
              update(
                {
                  grainParams: {
                    ...grain,
                    rmsBase: value,
                    rmsGranularity: offsets.map((offset) =>
                      Math.max(0, Math.min(100, value + offset))
                    ) as [number, number, number]
                  }
                },
                save
              )
            }
            reset={() =>
              update({
                grainParams: {
                  ...grain,
                  rmsBase: undefined,
                  rmsGranularity: grainDefaults.rmsGranularity
                }
              })
            }
            commit={commit}
          />
          {film && !monochrome && (
            <AdvancedDetails
              id="grainChannelOffsets"
              name={t('editor.grainChannelOffsets')}
              info={
                <HelpTooltip
                  label={t('editor.grainChannelOffsets')}
                  text={t('editor.grainChannelOffsetHelp')}
                />
              }
            >
              {(['red', 'green', 'blue'] as const).map((channel, index) => (
                <Adjustment
                  key={channel}
                  label={t(`editor.${channel}`)}
                  value={offsets[index]}
                  min={-base}
                  max={100 - base}
                  step={0.5}
                  change={(value, save) => offset(index, value, save)}
                  reset={() => offset(index, 0)}
                  commit={commit}
                />
              ))}
            </AdvancedDetails>
          )}
          {(
            [
              ['blur', 'grainBlur', 4, 0.01],
              ['multUsmAmount', 'grainSharpen', 4, 0.1]
            ] as const
          ).map(([key, label, max, step]) => (
            <Adjustment
              key={key}
              label={t(`editor.${label}`)}
              help={t(`editor.${label}Help`)}
              value={grain[key]}
              min={0}
              max={max}
              step={step}
              change={(value, save) => update({ grainParams: { ...grain, [key]: value } }, save)}
              reset={() => update({ grainParams: { ...grain, [key]: grainDefaults[key] } })}
              commit={commit}
            />
          ))}
        </>
      )}
      {header('halation', resetHalation, !!halation)}
      {!halation && <p className="text-xs text-tone-400">{t('editor.legacyFilmEffect')}</p>}
      {halation &&
        fx.halation &&
        (
          [
            ['scatterAmount', 1, 0.05],
            ['scatterSpatialScale', 4, 0.1],
            ['halationAmount', 4, 0.05],
            ['halationSpatialScale', 4, 0.1]
          ] as const
        ).map(([key, max, step]) => (
          <Adjustment
            key={key}
            label={t(`editor.${key}`)}
            help={t(`editor.${key}Help`)}
            value={halation[key]}
            min={0}
            max={max}
            step={step}
            change={(value, save) =>
              update({ halationParams: { ...halation, [key]: value } }, save)
            }
            reset={() =>
              update({ halationParams: { ...halation, [key]: DEFAULT_FILM.halationParams![key] } })
            }
            commit={commit}
          />
        ))}
    </Section>
  )
}
