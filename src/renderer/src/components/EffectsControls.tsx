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
import { EDITOR_SECTIONS, resetSection } from '@shared/editorSections'
import { Button } from './ui/button'
import { AdvancedDetails } from './ui/advancedDetails'
import { HelpTooltip } from './ui/settingsLayout'
import { Switch } from './ui/switch'
import { Adjustment, Section } from './EditorControls'

/**
 * The Grain and Halation sections. A film stock stores them in `recipe.film`;
 * a profile without one stores them in `recipe.effects`.
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
  /** The section of one effect. Its switch is the first row; its menu resets it. */
  const section = (
    effect: 'grain' | 'halation',
    params: unknown,
    children: React.ReactNode
  ): React.JSX.Element => {
    const label = t(effect === 'grain' ? 'editor.enableGrain' : 'editor.enableHalation')
    return (
      <Section id={effect} name={t(`editor.${effect}`)}>
        {/* The help of halation follows its label; grain needs none. */}
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5 font-sans text-[13px] text-tone-300">
            {label}
            {effect === 'halation' && (
              <HelpTooltip
                label={label}
                text={t(film ? 'editor.halationHelp' : 'editor.halationLookHelp')}
              />
            )}
          </span>
          <Switch
            aria-label={label}
            checked={fx[effect]}
            disabled={disabled || !params}
            onCheckedChange={(on) => update({ [effect]: on })}
          />
        </div>
        {params ? (
          fx[effect] && children
        ) : (
          // Saved effects of an older version keep rendering until this reset replaces them.
          <>
            <p className="text-xs text-tone-400">{t('editor.legacyFilmEffect')}</p>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => change(resetSection(EDITOR_SECTIONS[effect], recipe, recipe))}
            >
              {t(effect === 'grain' ? 'editor.resetGrain' : 'editor.resetHalation')}
            </Button>
          </>
        )}
      </Section>
    )
  }
  return (
    <>
      {section(
        'grain',
        grain,
        grain && (
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
        )
      )}
      {section(
        'halation',
        halation,
        halation &&
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
                update({
                  halationParams: { ...halation, [key]: DEFAULT_FILM.halationParams![key] }
                })
              }
              commit={commit}
            />
          ))
      )}
    </>
  )
}
