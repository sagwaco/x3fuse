import { memo, useContext, useEffect, useRef, useState } from 'react'
import { DenoiseControls } from './DenoiseControls'
import {
  ChevronDown,
  Aperture,
  Film,
  Palette,
  RotateCcw,
  Pipette,
  Plus,
  Trash2
} from 'lucide-react'
import {
  DEFAULT_FILM,
  FILM_MONOCHROME_FILTERS,
  MONOCHROME_FILTERS,
  defaultRecipe,
  negativePrint,
  type EditRecipe,
  type FilmSettings,
  type CurvePoint,
  type MonochromeFilter
} from '@shared/editor'
import stocks from '@shared/film-stocks.json'
import { curvePath, evaluateCurve } from '@shared/curves'
import { needsX3iMerge, useEditorStore } from '../stores/editorStore'
import { DevelopingCloud } from '../lib/developingCloud'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { withShortcut } from '../lib/shortcut'
import { Button } from './ui/button'
import { cn } from '../lib/cn'
import { Select } from './ui/select'
import { Slider } from './ui/slider'
import { HelpTooltip, ToggleRow } from './ui/settingsLayout'
import { LookPicker } from './LookPicker'
import { SfdRaw, SfdRawInfo } from './SfdRaw'
import { EffectsSection } from './EffectsControls'
import { useStoredOpen } from '../hooks/useStoredOpen'

/** Tracks that show which way a slider moves the picture. */
const TEMPERATURE = 'linear-gradient(to right, #4f7cff, #d4d4d4, #ffb43d)'
const TINT = 'linear-gradient(to right, #3fbf5a, #d4d4d4, #e14fd0)'
/** White balance presets in kelvin at zero tint. As shot is the camera's own. */
const WHITE_BALANCE = [
  ['asShot', null],
  ['daylight', 5500],
  ['cloudy', 6500],
  ['shade', 7500],
  ['tungsten', 2850],
  ['flash', 6000]
] as const
/** Maps values onto slider positions, for a slider that is not linear. */
interface Scale {
  to: (value: number) => number
  from: (position: number) => number
  /** One arrow key step, in positions. */
  step: number
}
/** The extended range spaces temperature by ratio and tint finest near zero. */
const KELVIN: Scale = { to: Math.log, from: Math.exp, step: 0.01 }
const TINT_SCALE: Scale = {
  to: (tint: number) => Math.asinh(tint / 100),
  from: (position: number) => 100 * Math.sinh(position),
  step: 0.01
}
const PANEL_TABS = [
  ['raw', 'tabRaw', Aperture],
  ['film', 'tabFilm', Film],
  ['grading', 'tabGrading', Palette]
] as const
const hsl = (hue: number, saturation = 75, lightness = 55): string =>
  `hsl(${hue} ${saturation}% ${lightness}%)`
/** Color mixer bands, in the renderer's order, by hue in degrees. */
const BANDS = [
  ['red', 0],
  ['orange', 30],
  ['yellow', 60],
  ['green', 120],
  ['aqua', 180],
  ['blue', 240],
  ['purple', 270],
  ['magenta', 300]
] as const
const FILTER_COLORS: Record<MonochromeFilter, string> = {
  neutral: '#a3a3a3',
  red: hsl(0),
  orange: hsl(30),
  yellow: hsl(55),
  green: hsl(120),
  blue: hsl(225)
}
const filmStock = (film: FilmSettings | null): (typeof stocks)[number] | undefined =>
  stocks.find((stock) => !stock.isPaper && stock.index === film?.film)
const monochromeFilm = (film: FilmSettings | null): boolean => !!filmStock(film)?.monochrome
const positiveFilm = (film: FilmSettings | null): boolean => !!filmStock(film)?.isPositive
/** For a help icon in a `group/reset` row. It hides while the row's label shows Reset. */
export const HIDE_WHILE_RESETTING = 'group-has-[[data-resetting]]/reset:invisible'

export function ResetLabel({
  label,
  disabled,
  reset
}: {
  label: string
  disabled: boolean
  reset: () => void
}): React.JSX.Element {
  // Shift-click on the label resets the slider. The label says so while Shift is held.
  const [hover, setHover] = useState(false)
  const [shift, setShift] = useState(false)
  useEffect(() => {
    if (!hover) return
    const track = (event: KeyboardEvent): void => setShift(event.shiftKey)
    window.addEventListener('keydown', track)
    window.addEventListener('keyup', track)
    return () => {
      window.removeEventListener('keydown', track)
      window.removeEventListener('keyup', track)
    }
  }, [hover])
  const resetting = hover && shift && !disabled
  return (
    <>
      {/* Both texts share one cell, so the label keeps its width and the pointer stays on it. */}
      <span
        data-resetting={resetting || undefined}
        className={cn(
          'control-label grid min-w-0 select-none',
          resetting && 'cursor-pointer text-tone-100'
        )}
        onPointerEnter={(event) => {
          setHover(true)
          setShift(event.shiftKey)
        }}
        onPointerMove={(event) => setShift(event.shiftKey)}
        onPointerLeave={() => setHover(false)}
        onClick={(event) => {
          if (event.shiftKey && !disabled) reset()
        }}
      >
        <span className={cn('col-start-1 row-start-1 truncate', resetting && 'invisible')}>
          {label}
        </span>
        <span
          aria-hidden="true"
          className={cn('col-start-1 row-start-1', !resetting && 'invisible')}
        >
          {t('editor.reset')}
        </span>
      </span>
    </>
  )
}

export function Adjustment({
  label,
  value,
  min = -100,
  max = 100,
  step = 1,
  help,
  unit,
  track,
  scale,
  change,
  reset,
  commit
}: {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  /** Only for controls whose effect the label can't convey on its own. */
  help?: string
  /** Shown after the label, such as EV. */
  unit?: string
  track?: string
  scale?: Scale
  change: (value: number, commit: boolean) => void
  reset: () => void
  commit: () => void
}): React.JSX.Element {
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  // The controls turn on after the developing cloud leaves. Turning them all
  // on at once takes a few milliseconds, and the cloud would skip a frame.
  const cloud = useContext(DevelopingCloud)
  const inactive = useEditorStore(
    (state) => cloud || state.before || state.loading || state.closing || !state.preview
  )
  const disabled = busy || inactive
  // A drag keeps the range it started with, so the thumb stays under the pointer.
  const [held, setHeld] = useState<{ min: number; max: number; step: number; scale?: Scale }>()
  const range = held ?? { min, max, step, scale }
  const fit = (value: number): number =>
    Math.max(range.min, Math.min(range.max, Math.round(value / range.step) * range.step))
  const map = range.scale
  return (
    <div
      className="space-y-1.5 py-2"
      onPointerDown={() => setHeld({ min, max, step, scale })}
      onPointerUp={() => setHeld(undefined)}
      onPointerCancel={() => setHeld(undefined)}
    >
      <div className="group/reset flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <ResetLabel
            label={unit ? `${label} (${unit})` : label}
            disabled={disabled}
            reset={reset}
          />
          {help && <HelpTooltip label={label} text={help} className={HIDE_WHILE_RESETTING} />}
        </span>
        <input
          aria-label={label}
          type="number"
          disabled={disabled}
          min={min}
          max={max}
          step={step}
          value={Number(value.toFixed(4))}
          // Shifted right so its digits end where the slider ends. Focus shows the box, in line.
          className="h-6 w-14 shrink-0 translate-x-2.5 rounded-md border border-transparent bg-transparent px-2 text-right font-mono text-xs tabular-nums text-tone-400 transition-transform [appearance:textfield] focus:translate-x-0 focus:border-ink/40 focus:bg-ink/[0.03] focus:text-tone-100 focus:outline-none disabled:opacity-40 motion-reduce:transition-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          onChange={(event) => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isFinite(value)) change(fit(value), true)
          }}
        />
      </div>
      <Slider
        disabled={disabled}
        aria-label={label}
        value={map ? map.to(value) : value}
        min={map ? map.to(range.min) : range.min}
        max={map ? map.to(range.max) : range.max}
        step={map?.step ?? range.step}
        valueText={map && String(value)}
        track={track}
        onValueChange={(value) => change(map ? fit(map.from(value)) : value, false)}
        // Radix rounds a step onto its grid of positions, and the value rounds back.
        onKeyStep={
          map &&
          ((direction, large) => {
            const next = fit(map.from(map.to(value) + direction * (large ? 10 : 1) * map.step))
            if (next !== value) change(next, true)
          })
        }
        onValueCommit={commit}
        onReset={reset}
      />
    </div>
  )
}

export function Section({
  id,
  name,
  info,
  children
}: {
  /** Keeps the open state of the section between sessions. Each section has its own. */
  id: string
  name: string
  /** An icon button after the name, such as an info popover. */
  info?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useStoredOpen(id)
  // Sections reach the panel edges, divided by rules; a nested one does too.
  // An open section fades from a faint light under its header to dark by its first
  // field, so its start is easy to see.
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="border-t border-ink/10 px-4 open:bg-gradient-to-b open:from-ink/[0.03] open:to-transparent open:bg-[length:100%_3rem] open:bg-no-repeat [details_&]:-mx-4"
    >
      <summary className="control-label flex cursor-pointer list-none items-center gap-1.5 rounded py-3 font-bold tracking-[0.16em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50 [&::-webkit-details-marker]:hidden">
        {name}
        {info}
        <ChevronDown
          aria-hidden="true"
          className="ml-auto h-3.5 w-3.5 text-tone-500 transition-transform [details[open]>summary>&]:rotate-180"
        />
      </summary>
      <div className="space-y-2 pb-3">{children}</div>
    </details>
  )
}

/** One-of-many color choice shown as swatches rather than names. */
function Swatches<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string; color: string }>
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2.5 py-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.label}
          title={option.label}
          onClick={() => onChange(option.value)}
          className="h-5 w-5 rounded-full ring-offset-2 ring-offset-tone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/60 disabled:opacity-40 aria-checked:ring-2 aria-checked:ring-ink"
          style={{ background: option.color }}
        />
      ))}
    </div>
  )
}

// The editor screen renders again for each preview. The controls do not
// change then, and rendering them again would delay animation frames.
export const EditorControls = memo(function EditorControls({
  recipe,
  picking,
  setPicking,
  onNavigate
}: {
  recipe: EditRecipe
  picking: boolean
  setPicking: (value: boolean) => void
  onNavigate: (page: 'emulsion' | 'paper') => void
}): React.JSX.Element {
  const [tab, setPanelTab] = useState<(typeof PANEL_TABS)[number][0]>('raw')
  // The white balance picker lives on RAW, so leaving it disarms the picker.
  const setTab = (next: (typeof PANEL_TABS)[number][0]): void => {
    if (next !== 'raw') setPicking(false)
    setPanelTab(next)
  }
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const x3i = useEditorStore((state) => state.x3i)
  // While an X3I merges an SFD RAW that it uses, only the SFD RAW section works.
  const pending = useEditorStore(needsX3iMerge)
  const inert = pending ? { inert: '', className: 'opacity-50' } : {}
  const cloud = useContext(DevelopingCloud)
  const asShotTemperature = useEditorStore((state) =>
    cloud ? undefined : state.preview?.asShotTemperature
  )
  const asShotTint = useEditorStore((state) => (cloud ? undefined : state.preview?.asShotTint))
  const [band, setBand] = useState(0)
  const [extended, setExtended] = useState(false)
  const hue = BANDS[band][1]
  const preset =
    WHITE_BALANCE.find(([, kelvin]) => recipe.temperature === kelvin && recipe.tint === 0)?.[0] ??
    'custom'
  const temperature = recipe.temperature ?? Math.round(asShotTemperature ?? 6500)
  // A value past the normal range enables the extended controls.
  const wideTemperature =
    extended || temperature < 2000 || temperature > 12000 || Math.abs(recipe.tint) > 100
  // As shot, Tint is a green gain, not an offset from the light source.
  const wideTint = (wideTemperature && recipe.temperature !== null) || Math.abs(recipe.tint) > 100
  const control = (
    key: keyof EditRecipe,
    options: Partial<Parameters<typeof Adjustment>[0]> = {}
  ): React.JSX.Element => (
    <Adjustment
      key={key}
      label={t(`editor.${key}`)}
      value={Number(recipe[key])}
      change={(value, commit) => change({ [key]: value }, commit)}
      reset={() => change({ [key]: defaultRecipe()[key] })}
      commit={commit}
      {...options}
    />
  )
  const mixer = (key: 'hue' | 'saturation' | 'luminance', track: string): React.JSX.Element => (
    <Adjustment
      key={`hsl-${key}`}
      label={t(`editor.${key}`)}
      value={recipe.hsl[band][key]}
      track={track}
      commit={commit}
      reset={() =>
        change({
          hsl: recipe.hsl.map((entry, index) => (index === band ? { ...entry, [key]: 0 } : entry))
        })
      }
      change={(value, commit) =>
        change(
          {
            hsl: recipe.hsl.map((entry, index) =>
              index === band ? { ...entry, [key]: value } : entry
            )
          },
          commit
        )
      }
    />
  )
  return (
    <>
      {x3i && (
        <Section id="sfdRaw" name={t('editor.sfdRaw')} info={!x3i.processed && <SfdRawInfo />}>
          <SfdRaw recipe={recipe} />
        </Section>
      )}
      {/* A toolbar as in macOS settings: the chosen tab sits on a soft fill in the accent color. */}
      <div
        role="tablist"
        aria-label={t('editor.panels')}
        className="flex justify-center gap-2 px-3 py-2.5"
      >
        {PANEL_TABS.map(([value, label, Icon], index) => (
          <button
            key={value}
            id={`panel-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              const count = PANEL_TABS.length
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % count
                  : event.key === 'ArrowLeft'
                    ? (index + count - 1) % count
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? count - 1
                        : -1
              if (next < 0) return
              event.preventDefault()
              setTab(PANEL_TABS[next][0])
              document.getElementById(`panel-tab-${PANEL_TABS[next][0]}`)?.focus()
            }}
            className="flex min-w-[4.5rem] max-w-[7rem] flex-col items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium leading-none text-tone-400 hover:bg-ink/[0.03] hover:text-tone-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50 aria-selected:bg-ink/[0.07] aria-selected:text-accent disabled:opacity-40"
          >
            <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
            <span className="max-w-full truncate">{t(`editor.${label}`)}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`panel-tab-${tab}`}>
        <div {...inert}>
          {tab === 'raw' && (
            <>
              <Section id="light" name={t('editor.light')}>
                {recipe.film ? (
                  <Adjustment
                    label={t('editor.exposure')}
                    value={recipe.film.evFilm}
                    unit="EV"
                    min={-3}
                    max={3}
                    step={0.05}
                    change={(evFilm, save) => change({ film: { ...recipe.film!, evFilm } }, save)}
                    reset={() => change({ film: { ...recipe.film!, evFilm: DEFAULT_FILM.evFilm } })}
                    commit={commit}
                  />
                ) : (
                  control('exposure', { unit: 'EV', min: -5, max: 5, step: 0.05 })
                )}
                {(['contrast', 'highlights', 'shadows', 'whites', 'blacks'] as const).map((key) =>
                  control(key)
                )}
                {control('fillLight', {
                  min: -2,
                  max: 2,
                  step: 0.1,
                  help: t('editor.fillLightHelp')
                })}
              </Section>
              <Section id="curves" name={t('editor.curves')}>
                <Curves recipe={recipe} />
              </Section>
              <Section id="whiteBalance" name={t('editor.whiteBalance')}>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    aria-label={t('editor.picker')}
                    title={withShortcut(t('editor.picker'), 'W')}
                    aria-keyshortcuts="W"
                    aria-pressed={picking}
                    onClick={() => setPicking(!picking)}
                  >
                    <Pipette aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                  <Select
                    aria-label={t('editor.whiteBalancePreset')}
                    className="flex-1"
                    value={preset}
                    options={[
                      ...WHITE_BALANCE.map(([key]) => ({ value: key, label: t(`editor.${key}`) })),
                      // Custom only names a balance that is not a preset.
                      ...(preset === 'custom'
                        ? [{ value: preset, label: t('editor.customWhiteBalance'), disabled: true }]
                        : [])
                    ]}
                    onValueChange={(key) => {
                      const kelvin = WHITE_BALANCE.find(([name]) => name === key)?.[1]
                      if (kelvin !== undefined) change({ temperature: kelvin, tint: 0 })
                    }}
                  />
                  <Button
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    aria-label={t('editor.resetWhiteBalance')}
                    title={t('editor.resetWhiteBalance')}
                    disabled={preset === 'asShot'}
                    onClick={() => change({ temperature: null, tint: 0 })}
                  >
                    <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {picking && (
                  <p role="status" className="control-label text-tone-100">
                    {t('editor.pickNeutral')}
                  </p>
                )}
                <Adjustment
                  label={t('editor.temperature')}
                  value={temperature}
                  min={wideTemperature ? 500 : 2000}
                  max={wideTemperature ? 50000 : 12000}
                  step={wideTemperature ? 10 : 50}
                  scale={wideTemperature ? KELVIN : undefined}
                  track={TEMPERATURE}
                  // Leaving As shot starts from the camera's own tint, so nothing jumps.
                  change={(temperature, commit) =>
                    change(
                      recipe.temperature === null && recipe.tint === 0 && asShotTint !== undefined
                        ? { temperature, tint: Math.round(asShotTint) }
                        : { temperature },
                      commit
                    )
                  }
                  reset={() => change({ temperature: null })}
                  commit={commit}
                />
                {control('tint', {
                  track: TINT,
                  ...(wideTint && { min: -2000, max: 2000, scale: TINT_SCALE })
                })}
                <ToggleRow
                  label={t('editor.extendedRange')}
                  help={t('editor.extendedRangeHelp')}
                  checked={wideTemperature}
                  onChange={setExtended}
                />
              </Section>
              <Section id="detail" name={t('editor.detail')}>
                {control('sharpen', { min: 0, max: 100 })}
                {control('denoise', { min: 0, max: 10, help: t('editor.denoiseHelp') })}
                {recipe.denoise > 0 && (
                  <DenoiseControls
                    value={recipe.denoiseOptions}
                    change={(denoiseOptions, committed) => change({ denoiseOptions }, committed)}
                    commit={commit}
                  />
                )}
              </Section>
            </>
          )}
          {tab === 'film' && (
            <>
              <Section id="look" name={t('editor.look')}>
                <LookPicker kind="film" recipe={recipe} onOpen={() => onNavigate('emulsion')} />
                {/* A positive (slide) film is viewed directly. Printing it on negative
                    paper inverts it, so offer the papers only to undo that. */}
                {recipe.film && (!positiveFilm(recipe.film) || !recipe.film.negative) && (
                  <LookPicker kind="paper" recipe={recipe} onOpen={() => onNavigate('paper')} />
                )}
                {recipe.film && <FilmControls film={recipe.film} />}
              </Section>
              <EffectsSection recipe={recipe} />
            </>
          )}
          {tab === 'grading' && (
            <>
              <Section id="color" name={t('editor.color')}>
                {control('saturation')}
                {control('vibrance', { help: t('editor.vibranceHelp') })}
                <p className="control-label pt-2 text-[10px] text-tone-500">
                  {t('editor.colorBand')}
                </p>
                <Swatches
                  label={t('editor.colorBand')}
                  value={String(band)}
                  options={BANDS.map(([name, hue], index) => ({
                    value: String(index),
                    label: t(`editor.${name}`),
                    color: hsl(hue)
                  }))}
                  onChange={(value) => setBand(Number(value))}
                />
                {mixer(
                  'hue',
                  `linear-gradient(to right, ${hsl(hue - 30)}, ${hsl(hue)}, ${hsl(hue + 30)})`
                )}
                {mixer(
                  'saturation',
                  `linear-gradient(to right, ${hsl(hue, 0)}, ${hsl(hue, 100, 50)})`
                )}
                {mixer(
                  'luminance',
                  `linear-gradient(to right, ${hsl(hue, 70, 15)}, ${hsl(hue, 70, 85)})`
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </>
  )
})

export function EmulsionControls({ recipe }: { recipe: EditRecipe }): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  return (
    <>
      <LookPicker kind="film" recipe={recipe} gallery />
      <div className="px-4">
        {recipe.monochrome && (
          <p className="control-label flex items-center gap-1.5 pt-2 text-[10px] text-tone-500">
            {t('editor.filter')}
            <HelpTooltip label={t('editor.filter')} text={t('editor.monochromeHelp')} />
          </p>
        )}
        {recipe.monochrome && (
          <Swatches
            label={t('editor.filter')}
            value={recipe.monochrome.filter}
            options={(monochromeFilm(recipe.film)
              ? FILM_MONOCHROME_FILTERS
              : MONOCHROME_FILTERS
            ).map((filter) => ({
              value: filter,
              label: t(`editor.${filter}`),
              color: FILTER_COLORS[filter]
            }))}
            onChange={(filter) => change({ monochrome: { filter } })}
          />
        )}
      </div>
    </>
  )
}

const CHANNELS = {
  master: 'conic-gradient(#f87171, #4ade80, #60a5fa, #f87171)',
  red: '#f87171',
  green: '#4ade80',
  blue: '#60a5fa'
} as const

function Curves({ recipe }: { recipe: EditRecipe }): React.JSX.Element {
  const [channel, setChannel] = useState<keyof EditRecipe['curves']>('master')
  const [selected, setSelected] = useState(0)
  const drag = useRef<number | null>(null)
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const points = recipe.curves[channel]
  const active = Math.min(selected, points.length - 1)
  const endpoint = (index: number): boolean => index === 0 || index === points.length - 1
  const setPoints = (points: CurvePoint[], save = true): void =>
    change({ curves: { ...recipe.curves, [channel]: points } }, save)
  const move = (index: number, x: number, y: number, save: boolean): void => {
    const next = points.map((point, i) =>
      i === index
        ? {
            x:
              index === 0
                ? 0
                : index === points.length - 1
                  ? 1
                  : Math.max(points[index - 1].x + 0.005, Math.min(points[index + 1].x - 0.005, x)),
            y: Math.max(0, Math.min(1, y))
          }
        : point
    )
    setPoints(next, save)
  }
  const remove = (index: number): void => {
    if (endpoint(index)) return
    setPoints(points.filter((_, i) => i !== index))
    setSelected(Math.max(0, index - 1))
  }
  const position = (event: React.PointerEvent<SVGSVGElement>): CurvePoint => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height))
    }
  }
  const near = (point: CurvePoint): number =>
    points.findIndex((p) => Math.hypot(p.x - point.x, p.y - point.y) < 0.06)
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Swatches
          label={t('editor.curveChannel')}
          value={channel}
          options={(['master', 'red', 'green', 'blue'] as const).map((value) => ({
            value,
            label: t(`editor.${value}`),
            color: CHANNELS[value]
          }))}
          onChange={(value) => {
            setChannel(value)
            setSelected(0)
          }}
        />
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('editor.addPoint')}
            title={t('editor.addPoint')}
            disabled={points.length >= 16}
            onClick={() => {
              const gaps = points.slice(1).map((p, i) => ({ i, size: p.x - points[i].x }))
              const gap = gaps.reduce((a, b) => (a.size > b.size ? a : b))
              const point = {
                x: (points[gap.i].x + points[gap.i + 1].x) / 2,
                y: evaluateCurve(points, (points[gap.i].x + points[gap.i + 1].x) / 2)
              }
              setPoints([...points.slice(0, gap.i + 1), point, ...points.slice(gap.i + 1)])
              setSelected(gap.i + 1)
            }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('editor.removePoint')}
            title={t('editor.removePoint')}
            disabled={endpoint(active)}
            onClick={() => remove(active)}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('editor.resetCurve')}
            title={t('editor.resetCurve')}
            onClick={() => {
              setPoints(defaultRecipe().curves[channel])
              setSelected(0)
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <svg
        viewBox="0 0 200 200"
        aria-label={t('editor.curves')}
        role="group"
        className="aspect-square w-full touch-none rounded-lg border border-white/10 bg-black"
        onPointerDown={(event) => {
          const point = position(event)
          let index = near(point)
          if (
            index < 0 &&
            points.length < 16 &&
            point.x > 0.01 &&
            point.x < 0.99 &&
            points.every((p) => Math.abs(p.x - point.x) > 0.005)
          ) {
            const next = [...points, point].sort((a, b) => a.x - b.x)
            index = next.indexOf(point)
            setPoints(next, false)
          }
          if (index >= 0) {
            setSelected(index)
            drag.current = index
            event.currentTarget.setPointerCapture(event.pointerId)
          }
        }}
        onPointerMove={(event) => {
          if (drag.current !== null && points[drag.current]) {
            const p = position(event)
            move(drag.current, p.x, p.y, false)
          }
        }}
        onPointerUp={() => {
          drag.current = null
          commit()
        }}
        onPointerCancel={() => {
          drag.current = null
          commit()
        }}
        onDoubleClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          remove(
            near({
              x: (event.clientX - bounds.left) / bounds.width,
              y: 1 - (event.clientY - bounds.top) / bounds.height
            })
          )
        }}
      >
        {[50, 100, 150].map((v) => (
          <path key={v} d={`M${v} 0V200 M0 ${v}H200`} stroke="white" opacity="0.07" />
        ))}
        <path d="M0 200L200 0" stroke="white" opacity="0.15" strokeDasharray="3 4" />
        <path
          d={curvePath(points)}
          fill="none"
          stroke={channel === 'master' ? '#ddd' : CHANNELS[channel]}
          strokeWidth="2"
        />
        {points.map((point, index) => (
          <circle
            key={index}
            role="slider"
            tabIndex={0}
            aria-label={`${t('editor.curvePoint')} ${index + 1}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(point.y * 100)}
            aria-valuetext={`${Math.round(point.x * 100)} → ${Math.round(point.y * 100)}`}
            cx={point.x * 200}
            cy={(1 - point.y) * 200}
            r={index === active ? 4.5 : 3.5}
            fill={index === active ? '#fff' : '#888'}
            stroke="#000"
            strokeWidth="1.5"
            className="outline-none focus-visible:stroke-white"
            onFocus={() => setSelected(index)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.1 : 0.01
              const [dx, dy] =
                {
                  ArrowLeft: [-step, 0],
                  ArrowRight: [step, 0],
                  ArrowUp: [0, step],
                  ArrowDown: [0, -step]
                }[event.key] ?? []
              if (dx !== undefined) {
                event.preventDefault()
                move(index, point.x + dx, point.y + dy, true)
              } else if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault()
                remove(index)
              }
            }}
          />
        ))}
      </svg>
      <p className="text-[11px] leading-snug text-tone-500">{t('editor.curveHint')}</p>
    </>
  )
}

export function FilmControls({ film }: { film: FilmSettings }): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const negativePreview = useEditorStore((state) => state.negativePreview)
  const update = (patch: Partial<FilmSettings>, save = true): void =>
    change({ film: { ...film, ...patch } }, save)
  /** A friendlier scale over one film setting; `to`/`from` convert between them. */
  const slider = (
    key: keyof FilmSettings,
    options: {
      min?: number
      max?: number
      step?: number
      to: (value: number) => number
      from: (setting: number) => number
      help?: string
      track?: string
    }
  ): React.JSX.Element => (
    <Adjustment
      key={key}
      label={t(`editor.${key}`)}
      value={
        Math.round(options.from(Number(film[key] ?? 0)) / (options.step ?? 1)) * (options.step ?? 1)
      }
      min={options.min}
      max={options.max}
      step={options.step}
      help={options.help}
      track={options.track}
      change={(value, save) => update({ [key]: options.to(value) }, save)}
      reset={() => update({ [key]: DEFAULT_FILM[key] })}
      commit={commit}
    />
  )
  // Contrast as stops of gamma: 0 is the stock's own, ±100 halves or doubles it.
  const contrast = { to: (v: number) => 2 ** (v / 100), from: (g: number) => Math.log2(g) * 100 }
  return (
    <>
      {negativePrint(film) && (
        <ToggleRow
          label={t('editor.negativePreview')}
          help={t('editor.negativePreviewHelp')}
          checked={negativePreview}
          onChange={(negativePreview) => useEditorStore.setState({ negativePreview })}
        />
      )}
      {/* Scanning the film directly skips the print, so its controls do nothing. */}
      {!film.negative && (
        <>
          {/* Enlarger settings are inverted so dragging right brightens and warms the print. */}
          <Adjustment
            label={t('editor.evPaper')}
            help={t('editor.evPaperHelp')}
            value={-(film.evPaper ?? 0)}
            min={-3}
            max={3}
            step={0.05}
            change={(value, save) => update({ evPaper: -value }, save)}
            reset={() => update({ evPaper: null })}
            commit={commit}
          />
          {/* Color filtration has no effect on a black-and-white print. */}
          {!monochromeFilm(film) && (
            <>
              {slider('tuneY', {
                to: (v) => -v / 100,
                from: (tune) => -tune * 100,
                track: TEMPERATURE
              })}
              {slider('tuneM', {
                to: (v) => -v / 100,
                from: (tune) => -tune * 100,
                track: TINT
              })}
            </>
          )}
        </>
      )}
      {slider('gammaFilm', { ...contrast, help: t('editor.gammaFilmHelp') })}
      {!film.negative && slider('gammaPaper', { ...contrast, help: t('editor.gammaPaperHelp') })}
      {/* One silver layer has no colors to separate; the default amount still applies. */}
      {!monochromeFilm(film) &&
        slider('couplers', {
          min: 0,
          max: 100,
          to: (v) => v / 100,
          from: (amount) => amount * 100,
          help: t('editor.couplersHelp')
        })}
    </>
  )
}
