import { useRef, useState } from 'react'
import { DenoiseControls } from './DenoiseControls'
import { ChevronDown, RotateCcw, RotateCw, Pipette, Plus, Trash2 } from 'lucide-react'
import {
  DEFAULT_FILM,
  MONOCHROME_FILTERS,
  defaultRecipe,
  type EditRecipe,
  type FilmSettings,
  type CurvePoint
} from '@shared/editor'
import stocks from '@shared/film-stocks.json'
import { useEditorStore } from '../stores/editorStore'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { Select } from './ui/select'
import { ToggleRow } from './ui/settingsLayout'

export function Adjustment({
  label,
  value,
  min = -100,
  max = 100,
  step = 1,
  change,
  reset,
  commit
}: {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  change: (value: number, commit: boolean) => void
  reset: () => void
  commit: () => void
}): React.JSX.Element {
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const inactive = useEditorStore(
    (state) => state.before || state.loading || state.closing || !state.preview
  )
  return (
    <div className="space-y-1.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="control-label">{label}</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <input
            aria-label={label}
            type="number"
            disabled={busy || inactive}
            min={min}
            max={max}
            step={step}
            value={Number(value.toFixed(4))}
            className="h-6 w-[4.5rem] rounded-md border border-white/10 bg-white/[0.03] px-2 text-right font-mono text-xs tabular-nums text-neutral-400 [appearance:textfield] focus:border-white/40 focus:text-neutral-100 focus:outline-none disabled:opacity-40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
        onValueChange={(value) => change(value, false)}
        onValueCommit={commit}
        onReset={reset}
      />
    </div>
  )
}

function Section({
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
      className="mx-3 mt-3 rounded-xl border border-white/10 px-4 [details_&]:mx-0"
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

export function EditorControls({
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
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const inactive = useEditorStore(
    (state) => state.before || state.loading || state.closing || !state.preview
  )
  const [band, setBand] = useState('0')
  const session = useEditorStore((state) => state.session)
  const asShotCrop = session?.asShotCrop ?? null
  const [freeCrop, setFreeCrop] = useState<{ path?: string; crop: EditRecipe['crop'] }>()
  const sourceWidth = useEditorStore((state) => state.preview?.sourceWidth)
  const sourceHeight = useEditorStore((state) => state.preview?.sourceHeight)
  const control = (key: keyof EditRecipe, min = -100, max = 100, step = 1): React.JSX.Element => (
    <Adjustment
      key={key}
      label={t(`editor.${key}`)}
      value={Number(recipe[key])}
      min={min}
      max={max}
      step={step}
      change={(value, commit) => change({ [key]: value }, commit)}
      reset={() => change({ [key]: defaultRecipe()[key] })}
      commit={commit}
    />
  )
  const crop = recipe.crop ?? { x: 0, y: 0, width: 1, height: 1 }
  const defaultCrop = asShotCrop ?? { x: 0, y: 0, width: 1, height: 1 }
  const presets = ['1:1', '3:2', '4:3', '5:7', '6:7', '16:9', '21:9', '65:24']
  const sameAsShot = (Object.keys(crop) as Array<keyof typeof crop>).every(
    (key) => Math.abs(crop[key] - defaultCrop[key]) < 0.00001
  )
  const cropRatio =
    sourceWidth && sourceHeight ? (crop.width * sourceWidth) / (crop.height * sourceHeight) : 0
  const outputRatio = recipe.rotation % 2 ? 1 / cropRatio : cropRatio
  const ratio =
    freeCrop?.path === session?.path && freeCrop?.crop === recipe.crop
      ? 'free'
      : sameAsShot
        ? 'asShot'
        : (presets.find((value) => {
            const [w, h] = value.split(':').map(Number)
            return Math.abs(outputRatio / (w / h) - 1) < 0.001
          }) ?? 'free')
  const setCrop = (key: keyof typeof crop, value: number, save: boolean): void => {
    const next = { ...crop, [key]: value / 100 }
    next.width = Math.max(0.01, Math.min(1 - next.x, next.width))
    next.height = Math.max(0.01, Math.min(1 - next.y, next.height))
    change({ crop: next }, save)
  }
  return (
    <>
      <div className="mx-3 space-y-3 rounded-xl border border-white/10 px-4 py-3">
        <ToggleRow
          label={t('editor.filmEnabled')}
          help={t('editor.filmHelp')}
          checked={recipe.film !== null}
          onChange={(enabled) => change({ film: enabled ? { ...DEFAULT_FILM } : null })}
        />
        <ToggleRow
          label={t('editor.monochrome')}
          help={t('editor.monochromeHelp')}
          checked={recipe.monochrome != null}
          disabled={busy || inactive}
          onChange={(enabled) => change({ monochrome: enabled ? { filter: 'neutral' } : null })}
        />
        {recipe.monochrome && (
          <Select
            card
            aria-label={t('editor.filter')}
            value={recipe.monochrome.filter}
            disabled={busy || inactive}
            options={MONOCHROME_FILTERS.map((filter) => ({
              value: filter,
              label: t(`editor.${filter}`)
            }))}
            onValueChange={(filter) => {
              const selected = MONOCHROME_FILTERS.find((value) => value === filter)
              if (selected) change({ monochrome: { filter: selected } })
            }}
          />
        )}
      </div>
      <Section name={t('editor.light')} open>
        {recipe.film ? (
          <Adjustment
            label={t('editor.evFilm')}
            value={recipe.film.evFilm}
            min={-3}
            max={3}
            step={0.05}
            change={(evFilm, save) => change({ film: { ...recipe.film!, evFilm } }, save)}
            reset={() => change({ film: { ...recipe.film!, evFilm: DEFAULT_FILM.evFilm } })}
            commit={commit}
          />
        ) : (
          control('exposure', -5, 5, 0.05)
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
          value={recipe.temperature ?? 6500}
          min={2000}
          max={12000}
          step={50}
          change={(temperature, commit) => change({ temperature }, commit)}
          reset={() => change({ temperature: null })}
          commit={commit}
        />
        {recipe.temperature === null && (
          <p className="control-label text-[10px] text-neutral-500">{t('editor.asShot')}</p>
        )}
        {control('tint')}
      </Section>
      <Section name={t('editor.curves')}>
        <Curves recipe={recipe} />
      </Section>
      <Section name={t('editor.color')}>
        {control('saturation')}
        {control('vibrance')}
        <Select
          card
          aria-label={t('editor.colorBand')}
          value={band}
          onValueChange={setBand}
          options={['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'].map(
            (name, index) => ({ value: String(index), label: t(`editor.${name}`) })
          )}
        />
        {(['hue', 'saturation', 'luminance'] as const).map((key) => (
          <Adjustment
            key={key}
            label={t(`editor.${key}`)}
            value={recipe.hsl[Number(band)][key]}
            commit={commit}
            reset={() =>
              change({
                hsl: recipe.hsl.map((entry, index) =>
                  index === Number(band) ? { ...entry, [key]: 0 } : entry
                )
              })
            }
            change={(value, commit) => {
              change(
                {
                  hsl: recipe.hsl.map((entry, index) =>
                    index === Number(band) ? { ...entry, [key]: value } : entry
                  )
                },
                commit
              )
            }}
          />
        ))}
      </Section>
      <Section name={t('editor.geometry')}>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="bordered"
            onClick={() => change({ rotation: (recipe.rotation + 1) % 4 })}
          >
            <RotateCw aria-hidden="true" className="h-3.5 w-3.5" />
            {t('editor.rotate')}
          </Button>
          <Button
            size="sm"
            variant="bordered"
            onClick={() => {
              change({ crop: asShotCrop, straighten: 0, rotation: 0 })
              setFreeCrop(undefined)
            }}
          >
            {t('editor.resetCrop')}
          </Button>
        </div>
        <Select
          card
          aria-label={t('editor.aspectRatio')}
          disabled={!sourceWidth || !sourceHeight}
          value={ratio}
          options={['asShot', 'free', ...presets].map((value) => ({
            value,
            label:
              value === 'free' || value === 'asShot'
                ? t(`editor.${value}`)
                : value === '65:24'
                  ? '65:24 (XPan)'
                  : value
          }))}
          onValueChange={(value) => {
            if (value === 'free') {
              setFreeCrop({ path: session?.path, crop: recipe.crop })
              return
            }
            setFreeCrop(undefined)
            if (value === 'asShot') {
              change({ crop: asShotCrop })
              return
            }
            const [w, h] = value.split(':').map(Number)
            if (!sourceWidth || !sourceHeight) return
            const imageRatio = sourceWidth / sourceHeight
            const target = (recipe.rotation % 2 ? h / w : w / h) / imageRatio
            const width = Math.min(1, target),
              height = Math.min(1, 1 / target)
            change({ crop: { x: (1 - width) / 2, y: (1 - height) / 2, width, height } })
          }}
        />
        {(['x', 'y', 'width', 'height'] as const).map((key) => (
          <Adjustment
            key={key}
            label={`${t(`editor.crop_${key}`)} (%)`}
            value={crop[key] * 100}
            min={key === 'width' || key === 'height' ? 1 : 0}
            max={key === 'x' || key === 'y' ? 99 : 100}
            step={0.1}
            change={(value, commit) => setCrop(key, value, commit)}
            reset={() => setCrop(key, defaultCrop[key] * 100, true)}
            commit={commit}
          />
        ))}
        {control('straighten', -45, 45, 0.1)}
      </Section>
      <Section name={t('editor.detail')}>
        {control('denoise', 0, 10)}
        {recipe.denoise > 0 && (
          <DenoiseControls
            value={recipe.denoiseOptions}
            change={(denoiseOptions, committed) => change({ denoiseOptions }, committed)}
            commit={commit}
          />
        )}
        {control('sharpen', 0, 100)}
      </Section>
      {recipe.film && (
        <Section name={t('editor.film')}>
          <FilmControls film={recipe.film} />
        </Section>
      )}
    </>
  )
}

function Curves({ recipe }: { recipe: EditRecipe }): React.JSX.Element {
  const [channel, setChannel] = useState<keyof EditRecipe['curves']>('master')
  const [selected, setSelected] = useState(0)
  const drag = useRef<number | null>(null)
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const points = recipe.curves[channel]
  const active = Math.min(selected, points.length - 1)
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
  const position = (event: React.PointerEvent<SVGSVGElement>): CurvePoint => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height))
    }
  }
  return (
    <>
      <Select
        card
        aria-label={t('editor.curveChannel')}
        value={channel}
        options={(['master', 'red', 'green', 'blue'] as const).map((value) => ({
          value,
          label: t(`editor.${value}`)
        }))}
        onValueChange={(value) => {
          setChannel(value)
          setSelected(0)
        }}
      />
      <svg
        viewBox="0 0 200 200"
        aria-label={t('editor.curves')}
        role="img"
        className="aspect-square w-full touch-none rounded-lg border border-white/10 bg-black"
        onPointerDown={(event) => {
          const point = position(event)
          let index = points.findIndex((p) => Math.hypot(p.x - point.x, p.y - point.y) < 0.06)
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
      >
        {[50, 100, 150].map((v) => (
          <path key={v} d={`M${v} 0V200 M0 ${v}H200`} stroke="white" opacity="0.07" />
        ))}
        <path d="M0 200L200 0" stroke="white" opacity="0.15" strokeDasharray="3 4" />
        <polyline
          points={points.map((point) => `${point.x * 200},${(1 - point.y) * 200}`).join(' ')}
          fill="none"
          stroke={
            channel === 'master'
              ? '#ddd'
              : channel === 'red'
                ? '#f87171'
                : channel === 'green'
                  ? '#4ade80'
                  : '#60a5fa'
          }
          strokeWidth="2"
        />
        {points.map((point, index) => (
          <circle
            key={index}
            cx={point.x * 200}
            cy={(1 - point.y) * 200}
            r={index === active ? 4 : 3}
            fill={index === active ? '#fff' : '#888'}
            stroke="#000"
            strokeWidth="1.5"
          />
        ))}
      </svg>
      <div className="flex flex-wrap gap-2">
        <Select
          aria-label={t('editor.curvePoint')}
          value={String(active)}
          options={points.map((_, index) => ({
            value: String(index),
            label: `${t('editor.curvePoint')} ${index + 1}`
          }))}
          onValueChange={(value) => setSelected(Number(value))}
        />
        <Button
          variant="bordered"
          size="sm"
          aria-label={t('editor.addPoint')}
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
          variant="bordered"
          size="sm"
          aria-label={t('editor.removePoint')}
          disabled={active === 0 || active === points.length - 1}
          onClick={() => {
            setPoints(points.filter((_, index) => index !== active))
            setSelected(Math.max(0, active - 1))
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      <Adjustment
        label={t('editor.curveInput')}
        value={points[active].x * 100}
        min={0}
        max={100}
        step={0.1}
        change={(value, save) => move(active, value / 100, points[active].y, save)}
        reset={() => move(active, points[active].y, points[active].y, true)}
        commit={commit}
      />
      <Adjustment
        label={t('editor.curveOutput')}
        value={points[active].y * 100}
        min={0}
        max={100}
        step={0.1}
        change={(value, save) => move(active, points[active].x, value / 100, save)}
        reset={() => move(active, points[active].x, points[active].x, true)}
        commit={commit}
      />
    </>
  )
}

function FilmControls({ film }: { film: FilmSettings }): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const update = (patch: Partial<FilmSettings>, save = true): void =>
    change({ film: { ...film, ...patch } }, save)
  const slider = (
    key: keyof FilmSettings,
    min: number,
    max: number,
    step = 0.01
  ): React.JSX.Element => (
    <Adjustment
      key={key}
      label={t(`editor.${key}`)}
      value={Number(film[key] ?? 0)}
      min={min}
      max={max}
      step={step}
      change={(value, save) => update({ [key]: value }, save)}
      reset={() => update({ [key]: DEFAULT_FILM[key] })}
      commit={commit}
    />
  )
  return (
    <>
      <Select
        card
        aria-label={t('editor.filmStock')}
        value={String(film.film)}
        onValueChange={(value) => update({ film: Number(value) })}
        options={stocks
          .filter((stock) => !stock.isPaper)
          .map((stock) => ({ value: String(stock.index), label: stock.name }))}
      />
      <Select
        card
        aria-label={t('editor.paperStock')}
        value={String(film.paper)}
        onValueChange={(value) => update({ paper: Number(value) })}
        options={stocks
          .filter((stock) => stock.isPaper)
          .map((stock) => ({ value: String(stock.index), label: stock.name }))}
      />
      <ToggleRow
        label={t('editor.autoPaperExposure')}
        checked={film.evPaper === null}
        onChange={(enabled) => update({ evPaper: enabled ? null : 0 })}
      />
      {film.evPaper !== null && slider('evPaper', -6, 6, 0.05)}
      <ToggleRow
        label={t('editor.negative')}
        checked={film.negative}
        onChange={(negative) => update({ negative })}
      />
      <Adjustment
        label={t('editor.grain')}
        value={film.grain ? film.grainAmount * 50 : 0}
        min={0}
        max={100}
        change={(value, save) =>
          update(
            {
              grain: value > 0,
              grainAmount: value / 50,
              grainSize: value <= 50 ? 0.25 + value * 0.015 : 1 + (value - 50) * 0.06,
              grainSaturation: Math.min(1, 0.5 + value / 100)
            },
            save
          )
        }
        reset={() =>
          update({
            grain: DEFAULT_FILM.grain,
            grainAmount: DEFAULT_FILM.grainAmount,
            grainSize: DEFAULT_FILM.grainSize,
            grainSaturation: DEFAULT_FILM.grainSaturation
          })
        }
        commit={commit}
      />
      <Section name={t('editor.grainAdvanced')}>
        <ToggleRow
          label={t('editor.grain')}
          checked={film.grain}
          onChange={(grain) => update({ grain })}
        />
        {film.grain && (
          <>
            {slider('grainSize', 0.25, 4)}
            {slider('grainAmount', 0, 2)}
            {slider('grainSaturation', 0, 1)}
          </>
        )}
      </Section>
      <Adjustment
        label={t('editor.halation')}
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
      <Section name={t('editor.halationAdvanced')}>
        <ToggleRow
          label={t('editor.halation')}
          checked={film.halation}
          onChange={(halation) => update({ halation })}
        />
        {film.halation && (
          <>
            {slider('halationStrength', 0, 2)}
            {slider('halationRadius', 0.0005, 0.006, 0.0001)}
            {slider('halationMidtones', 0, 1)}
          </>
        )}
      </Section>
      {slider('couplers', 0, 1)}
      {slider('couplersRadius', 0, 0.05, 0.0001)}
      {slider('gammaFilm', 0.5, 2)}
      {slider('gammaPaper', 0.5, 2)}
      {slider('tuneM', -1, 1)}
      {slider('tuneY', -1, 1)}
    </>
  )
}
