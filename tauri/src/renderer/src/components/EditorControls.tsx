import { memo, useContext, useRef, useState } from 'react'
import { DenoiseControls } from './DenoiseControls'
import { ChevronDown, RotateCcw, Pipette, Plus, Trash2 } from 'lucide-react'
import {
  DEFAULT_FILM,
  FILM_MONOCHROME_FILTERS,
  MONOCHROME_FILTERS,
  defaultRecipe,
  type EditRecipe,
  type FilmSettings,
  type CurvePoint,
  type MonochromeFilter
} from '@shared/editor'
import stocks from '@shared/film-stocks.json'
import { useEditorStore } from '../stores/editorStore'
import { DevelopingCloud } from '../lib/developingCloud'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { HelpTooltip, ToggleRow } from './ui/settingsLayout'
import { LookPicker } from './LookPicker'

/** Tracks that show which way a slider moves the picture. */
const TEMPERATURE = 'linear-gradient(to right, #4f7cff, #d4d4d4, #ffb43d)'
const TINT = 'linear-gradient(to right, #3fbf5a, #d4d4d4, #e14fd0)'
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

export function Adjustment({
  label,
  value,
  min = -100,
  max = 100,
  step = 1,
  help,
  track,
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
  track?: string
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
  return (
    <div className="space-y-1.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="control-label truncate">{label}</span>
          {help && <HelpTooltip label={label} text={help} />}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <input
            aria-label={label}
            type="number"
            disabled={busy || inactive}
            min={min}
            max={max}
            step={step}
            value={Number(value.toFixed(4))}
            className="h-6 w-14 rounded-md border border-white/10 bg-white/[0.03] px-2 text-right font-mono text-xs tabular-nums text-neutral-400 [appearance:textfield] focus:border-white/40 focus:text-neutral-100 focus:outline-none disabled:opacity-40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber
              if (Number.isFinite(value))
                change(Math.max(min, Math.min(max, Math.round(value / step) * step)), true)
            }}
          />
          <button
            type="button"
            aria-label={`${t('editor.reset')} ${label}`}
            title={t('editor.reset')}
            disabled={busy || inactive}
            onClick={reset}
            className="rounded p-0.5 text-neutral-500 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <Slider
        disabled={busy || inactive}
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        track={track}
        onValueChange={(value) => change(value, false)}
        onValueCommit={commit}
        onReset={reset}
      />
    </div>
  )
}

export function Section({
  name,
  open = false,
  children
}: {
  name: string
  open?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <details
      open={open || undefined}
      className="mx-3 mt-3 rounded-xl border border-white/10 px-4 [details_&]:mx-0 [details_&]:rounded-none [details_&]:border-x-0 [details_&]:border-b-0 [details_&]:px-0"
    >
      <summary className="control-label flex cursor-pointer list-none items-center justify-between rounded py-3 tracking-[0.16em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 [&::-webkit-details-marker]:hidden">
        {name}
        <ChevronDown
          aria-hidden="true"
          className="h-3.5 w-3.5 text-neutral-500 transition-transform [details[open]>summary>&]:rotate-180"
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
          className="h-5 w-5 rounded-full ring-offset-2 ring-offset-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40 aria-checked:ring-2 aria-checked:ring-white"
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
  setPicking
}: {
  recipe: EditRecipe
  picking: boolean
  setPicking: (value: boolean) => void
}): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const cloud = useContext(DevelopingCloud)
  const asShotTemperature = useEditorStore((state) =>
    cloud ? undefined : state.preview?.asShotTemperature
  )
  const asShotTint = useEditorStore((state) => (cloud ? undefined : state.preview?.asShotTint))
  const [band, setBand] = useState(0)
  const hue = BANDS[band][1]
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
      key={key}
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
      <Section name={t('editor.look')} open>
        <LookPicker kind="film" recipe={recipe} />
        {recipe.monochrome && (
          <p className="control-label flex items-center gap-1.5 pt-2 text-[10px] text-neutral-500">
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
        {recipe.film && <FilmControls film={recipe.film} recipe={recipe} />}
      </Section>
      <Section name={t('editor.light')} open>
        {recipe.film ? (
          <Adjustment
            label={t('editor.exposure')}
            value={recipe.film.evFilm}
            min={-3}
            max={3}
            step={0.05}
            change={(evFilm, save) => change({ film: { ...recipe.film!, evFilm } }, save)}
            reset={() => change({ film: { ...recipe.film!, evFilm: DEFAULT_FILM.evFilm } })}
            commit={commit}
          />
        ) : (
          control('exposure', { min: -5, max: 5, step: 0.05 })
        )}
        {(['contrast', 'highlights', 'shadows', 'whites', 'blacks'] as const).map((key) =>
          control(key)
        )}
      </Section>
      <Section name={t('editor.whiteBalance')} open>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="bordered"
            aria-pressed={recipe.temperature === null && recipe.tint === 0}
            onClick={() => change({ temperature: null, tint: 0 })}
          >
            {t('editor.asShot')}
          </Button>
          <Button
            size="sm"
            variant="bordered"
            aria-pressed={picking}
            onClick={() => setPicking(!picking)}
          >
            <Pipette aria-hidden="true" className="h-3.5 w-3.5" />
            {t('editor.picker')}
          </Button>
        </div>
        {picking && (
          <p role="status" className="control-label text-neutral-100">
            {t('editor.pickNeutral')}
          </p>
        )}
        <Adjustment
          label={t('editor.temperature')}
          value={recipe.temperature ?? Math.round(asShotTemperature ?? 6500)}
          min={2000}
          max={12000}
          step={50}
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
        {control('tint', { track: TINT })}
      </Section>
      <Section name={t('editor.color')}>
        {control('saturation')}
        {control('vibrance', { help: t('editor.vibranceHelp') })}
        <p className="control-label pt-2 text-[10px] text-neutral-500">{t('editor.colorBand')}</p>
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
        {mixer('hue', `linear-gradient(to right, ${hsl(hue - 30)}, ${hsl(hue)}, ${hsl(hue + 30)})`)}
        {mixer('saturation', `linear-gradient(to right, ${hsl(hue, 0)}, ${hsl(hue, 100, 50)})`)}
        {mixer('luminance', `linear-gradient(to right, ${hsl(hue, 70, 15)}, ${hsl(hue, 70, 85)})`)}
      </Section>
      <Section name={t('editor.curves')}>
        <Curves recipe={recipe} />
      </Section>
      <Section name={t('editor.detail')}>
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
  )
})

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
                y: (points[gap.i].y + points[gap.i + 1].y) / 2
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
        <polyline
          points={points.map((point) => `${point.x * 200},${(1 - point.y) * 200}`).join(' ')}
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
      <p className="text-[11px] leading-snug text-neutral-500">{t('editor.curveHint')}</p>
    </>
  )
}

function FilmControls({
  film,
  recipe
}: {
  film: FilmSettings
  recipe: EditRecipe
}): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
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
      <Adjustment
        label={t('editor.grain')}
        value={film.grain ? film.grainAmount * 50 : 0}
        min={0}
        max={100}
        change={(value, save) => update({ grain: value > 0, grainAmount: value / 50 }, save)}
        reset={() => update({ grain: DEFAULT_FILM.grain, grainAmount: DEFAULT_FILM.grainAmount })}
        commit={commit}
      />
      {/* Logarithmic, so the stock's natural grain sits in the middle. */}
      {film.grain &&
        slider('grainSize', {
          min: 0,
          max: 100,
          to: (v) => 0.25 * 16 ** (v / 100),
          from: (size) => (Math.log(size / 0.25) / Math.log(16)) * 100
        })}
      <Adjustment
        label={t('editor.halation')}
        help={t('editor.halationHelp')}
        value={film.halation ? film.halationStrength * 50 : 0}
        min={0}
        max={100}
        change={(value, save) => {
          const strength = value / 50
          const spread = Math.max(
            0,
            (strength - DEFAULT_FILM.halationStrength) / (2 - DEFAULT_FILM.halationStrength)
          )
          update(
            {
              halation: value > 0,
              halationStrength: strength,
              halationRadius:
                strength <= DEFAULT_FILM.halationStrength
                  ? 0.0005 +
                    ((DEFAULT_FILM.halationRadius - 0.0005) * strength) /
                      DEFAULT_FILM.halationStrength
                  : DEFAULT_FILM.halationRadius + (0.006 - DEFAULT_FILM.halationRadius) * spread,
              halationMidtones: spread
            },
            save
          )
        }}
        reset={() =>
          update({
            halation: DEFAULT_FILM.halation,
            halationStrength: DEFAULT_FILM.halationStrength,
            halationRadius: DEFAULT_FILM.halationRadius,
            halationMidtones: DEFAULT_FILM.halationMidtones
          })
        }
        commit={commit}
      />
      <Section name={t('editor.darkroom')}>
        {/* Scanning the film directly skips the print, so its controls do nothing. */}
        {!film.negative && (
          <>
            <LookPicker kind="paper" recipe={recipe} />
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
        {/* A positive (slide) film is viewed directly. Printing it on negative
            paper inverts it, so offer the switch only to undo that. */}
        {(!positiveFilm(film) || !film.negative) && (
          <ToggleRow
            label={t('editor.negative')}
            checked={film.negative}
            onChange={(negative) => update({ negative })}
          />
        )}
      </Section>
    </>
  )
}
