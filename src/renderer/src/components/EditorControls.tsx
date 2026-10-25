import { memo, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { DenoiseControls } from './DenoiseControls'
import { ChevronDown, Aperture, Film, Blend, Pipette, RotateCcw } from 'lucide-react'
import {
  capabilitiesOf,
  DEFAULT_FILM,
  FOVEON_CAPABILITIES,
  FILM_MONOCHROME_FILTERS,
  IDENTITY_RAW_MATRIX,
  MONOCHROME_FILTERS,
  RAW_GAIN_RANGE,
  defaultRecipe,
  monochromeFilm,
  monochromeRawMatrix,
  negativePrint,
  type EditRecipe,
  type FilmSettings,
  type CurvePoint,
  type MonochromeFilter,
  type SourceCapabilities
} from '@shared/editor'
import stocks from '@shared/film-stocks.json'
import { curveInput, curvePath, evaluateCurve } from '@shared/curves'
import { useCurveQualifier } from '../stores/curveQualifierStore'
import { asShotRecipe, needsX3iMerge, useEditorStore } from '../stores/editorStore'
import { editorSection, pasteSection, resetSection } from '@shared/editorSections'
import { invalidateNativeMenu, showNativeMenu } from '../lib/nativeMenu'
import { DevelopingCloud } from '../lib/developingCloud'
import { useQueueStore } from '../stores/queueStore'
import { t, useLanguage } from '../lib/strings'
import { Button } from './ui/button'
import { cn } from '../lib/cn'
import { blurOnClick, blurOnEnter } from '../lib/commitFocus'
import { GlassGroup } from './ui/glassGroup'
import { Slider } from './ui/slider'
import { HelpTooltip, ToggleRow } from './ui/settingsLayout'
import { Select } from './ui/select'
import { LookPicker } from './LookPicker'
import { SfdRaw, SfdRawInfo } from './SfdRaw'
import { EffectsSection } from './EffectsControls'
import { useStoredOpen } from '../hooks/useStoredOpen'
import { animateDetails } from '../lib/animateDetails'
import { useSwitchTween } from '../lib/switchTween'
import { ColorMixer, ToneMixer } from './ColorMixer'
import { ColorWheels } from './ColorWheels'
import { useScopeImage } from '../hooks/useScopeImage'
import { useElementWidth } from '../hooks/useElementWidth'
import { histogram } from '../lib/scopes'
import { ChannelSwap, RawMatrixControls } from './RawColorControls'
import { WhiteBalanceControls } from './WhiteBalanceControls'

/** Tracks that show which way a slider moves the picture. */
export const TEMPERATURE = 'linear-gradient(to right, #3d5fc2, #8c8c8c, #c48a2f)'
export const TINT = 'linear-gradient(to right, #318f45, #8c8c8c, #a83b9c)'
/** Saturation and Vibrance fade from dark gray to color. */
const RAINBOW =
  'linear-gradient(to right, #525252, #737373 40%, #60a5fa 55%, #4ade80 70%, #facc15 85%, #f87171)'
/** Maps values onto slider positions, for a slider that is not linear. */
interface Scale {
  to: (value: number) => number
  from: (position: number) => number
  /** One arrow key step, in positions. */
  step: number
}
const PANEL_TABS = [
  ['raw', 'tabRaw', Aperture],
  ['film', 'tabFilm', Film],
  ['grading', 'tabGrading', Blend]
] as const
const hsl = (hue: number, saturation = 75, lightness = 55): string =>
  `hsl(${hue} ${saturation}% ${lightness}%)`
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
const positiveFilm = (film: FilmSettings | null): boolean => !!filmStock(film)?.isPositive
/** For a help icon in a `group/reset` row. It hides while the row's label shows Reset. */
export const HIDE_WHILE_RESETTING = 'group-has-[[data-resetting]]/reset:invisible'
/** Slider labels use the system font, without the caption case and letter spacing. */
export const SLIDER_LABEL =
  'font-sans text-[12px] normal-case leading-tight tracking-normal text-tone-300'

export function ResetLabel({
  label,
  disabled,
  reset,
  center = false
}: {
  label: string
  disabled: boolean
  reset: () => void
  /** Centers both texts, for a label above a centered control. */
  center?: boolean
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
          'slider-label grid min-w-0 select-none',
          SLIDER_LABEL,
          center && 'justify-items-center',
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
  short,
  row = false,
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
  commit,
  disabled: disabledOverride
}: {
  label: string
  /** A short visible label. With it, the label, slider and value share one row. */
  short?: string
  /** Keep the full label, slider and value in one row. */
  row?: boolean
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
  commit?: () => void
  /** Export controls do not depend on the editor preview state. */
  disabled?: boolean
}): React.JSX.Element {
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  // The controls turn on after the developing cloud leaves. Turning them all
  // on at once takes a few milliseconds, and the cloud would skip a frame.
  const cloud = useContext(DevelopingCloud)
  const inactive = useEditorStore(
    (state) => cloud || state.before || state.loading || state.closing || !state.preview
  )
  const disabled = disabledOverride ?? (busy || inactive)
  // A drag keeps the range it started with, so the thumb stays under the pointer.
  const [held, setHeld] = useState<{ min: number; max: number; step: number; scale?: Scale }>()
  const range = held ?? { min, max, step, scale }
  const fit = (value: number): number =>
    Math.max(range.min, Math.min(range.max, Math.round(value / range.step) * range.step))
  const map = range.scale
  const fresh = useRef(false)
  const [focused, setFocused] = useState(false)
  const full = String(Number(value.toFixed(4)))
  // Until focus shows the full value, a value shows at most 4 characters. Above a slider,
  // it keeps at least the precision of its step.
  const places = short || row ? 0 : Math.min(4, String(step).split('.')[1]?.length ?? 0)
  const shown = focused
    ? full
    : ([4, 3, 2, 1, 0]
        .filter((digits) => digits >= places)
        .map((digits) => String(Number(value.toFixed(digits))))
        .find((text) => text.length <= 4) ?? String(Number(value.toFixed(places))))
  const input = (
    <input
      aria-label={label}
      type="number"
      disabled={disabled}
      min={min}
      max={max}
      step={step}
      value={shown}
      // Above a slider, shifted right so its digits end where the slider ends. Focus shows
      // the box, in line. In a row, it fills a column as wide as the label column.
      className={cn(
        'h-6 shrink-0 rounded-md border font-sans border-transparent bg-transparent text-right text-xs tabular-nums text-tone-400 [appearance:textfield] focus:border-ink/40 focus:bg-ink/[0.03] focus:text-tone-100 focus:outline-none disabled:opacity-40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        short || row
          ? 'w-full px-0 text-[12px]'
          : 'w-14 translate-x-2.5 px-2 transition-transform focus:translate-x-0 motion-reduce:transition-none'
      )}
      // Select on focus so typing replaces the value. WebKit clears the selection on the
      // mouseup of the click that focused the field, so that mouseup is cancelled.
      onMouseDown={(event) => {
        fresh.current = document.activeElement !== event.currentTarget
      }}
      onFocus={(event) => {
        // Show the full value before the selection, so the render keeps it.
        event.currentTarget.value = full
        setFocused(true)
        event.currentTarget.select()
      }}
      onBlur={() => setFocused(false)}
      onKeyDown={blurOnEnter}
      onMouseUp={(event) => {
        if (fresh.current) event.preventDefault()
        fresh.current = false
      }}
      onChange={(event) => {
        const value = event.currentTarget.valueAsNumber
        if (Number.isFinite(value)) change(fit(value), true)
      }}
    />
  )
  const slider = (
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
  )
  const hold = {
    onPointerDown: () => setHeld({ min, max, step, scale }),
    onPointerUp: () => setHeld(undefined),
    onPointerCancel: () => setHeld(undefined)
  }
  if (short || row) {
    // The slider and value use the full name. Shift-click on the label resets.
    // Short labels use equal outer columns to center the slider.
    return (
      <div
        className={cn(
          'adjustment grid items-center py-0.5',
          row
            ? 'grid-cols-[minmax(0,5rem)_minmax(0,1fr)_2.375rem] gap-2'
            : 'grid-cols-[1.875rem_minmax(0,1fr)_1.875rem]'
        )}
        {...hold}
      >
        <span
          aria-hidden="true"
          title={label}
          className={cn('select-none truncate', SLIDER_LABEL)}
          onClick={(event) => {
            if (event.shiftKey && !disabled) reset()
          }}
        >
          {short ?? label}
        </span>
        {slider}
        {input}
      </div>
    )
  }
  return (
    <div className="adjustment space-y-px py-0.5" {...hold}>
      <div className="group/reset flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <ResetLabel
            label={unit ? `${label} (${unit})` : label}
            disabled={disabled}
            reset={reset}
          />
          {help && <HelpTooltip label={label} text={help} className={HIDE_WHILE_RESETTING} />}
        </span>
        {input}
      </div>
      {slider}
    </div>
  )
}

/** A section's settings that its context menu copied, for this session. */
let copiedSection: { id: string; recipe: EditRecipe; capabilities: SourceCapabilities } | null =
  null
/** The capabilities of the open photo. */
const openCapabilities = (): SourceCapabilities => {
  const session = useEditorStore.getState().session
  return session ? capabilitiesOf(session) : FOVEON_CAPABILITIES
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
  // An editor section with settings has a context menu, and Option-click resets it.
  const section = editorSection(id)
  const cloud = useContext(DevelopingCloud)
  const menuId = useId()
  useEffect(() => () => invalidateNativeMenu(menuId), [menuId])
  const summary = useRef<HTMLElement>(null)
  /** The open photo's recipe, while its controls work. */
  const editable = (): EditRecipe | undefined => {
    const editor = useEditorStore.getState()
    const queue = useQueueStore.getState()
    const off = cloud || queue.isProcessing || queue.isPreparing || editor.before
    if (off || editor.loading || editor.closing || !editor.preview || !editor.session) return
    return editor.documents[editor.session.path]?.recipe
  }
  const reset = (): void => {
    const recipe = editable()
    const { session, preview, change } = useEditorStore.getState()
    if (section && recipe) {
      const defaults = asShotRecipe(session, recipe.seed)
      if (id === 'whiteBalance' && recipe.rawColor && preview?.asShotGains) {
        const [red, green, blue] = preview.asShotGains
        const middle = recipe.rawColor.gains[1]
        const clamp = (gain: number): number =>
          Math.max(RAW_GAIN_RANGE[0], Math.min(RAW_GAIN_RANGE[1], (gain / green) * middle))
        defaults.rawColor = {
          gains: [clamp(red), middle, clamp(blue)],
          matrix: [...IDENTITY_RAW_MATRIX]
        }
      }
      change(resetSection(section, recipe, defaults))
    }
  }
  const menu = (x: number, y: number): void => {
    if (!section) return
    const session = useEditorStore.getState().session?.sessionId
    const off = !editable()
    const items = [
      { value: 'reset', label: t('context.reset_section', { name }), disabled: off },
      { value: 'copy', label: t('context.copy_section', { name }), disabled: off },
      {
        value: 'paste',
        label: t('context.paste_section', { name }),
        disabled: off || copiedSection?.id !== id
      },
      { value: 'expand', label: t('context.expand_all'), separatorBefore: true },
      { value: 'collapse', label: t('context.collapse_all') }
    ]
    const details = summary.current?.parentElement
    void showNativeMenu({ id: menuId, x, y, items }, (value) => {
      if (value === 'expand' || value === 'collapse') {
        // Each section saves its state from its toggle event.
        details
          ?.closest('[role="tabpanel"]')
          ?.querySelectorAll<HTMLDetailsElement>('details.editor-section')
          .forEach((other) => (other.open = value === 'expand'))
        return
      }
      const recipe = editable()
      if (!recipe || useEditorStore.getState().session?.sessionId !== session) return
      if (value === 'reset') reset()
      else if (value === 'copy')
        copiedSection = { id, recipe: structuredClone(recipe), capabilities: openCapabilities() }
      else if (value === 'paste' && copiedSection?.id === id)
        useEditorStore
          .getState()
          .change(
            pasteSection(
              section,
              id,
              copiedSection.recipe,
              recipe,
              copiedSection.capabilities,
              openCapabilities()
            )
          )
    }).catch((error: unknown) => console.error('Could not open native context menu', error))
  }
  // Sections reach the panel edges, divided by rules; a nested one does too.
  // A section is transparent at rest. While the pointer or the focus is in it, it fades
  // from a faint light under its header to dark by its first field (see .editor-section).
  // The header stays at the top of the sidebar while its section scrolls under it. It has
  // the panel color (tone-900/30 on tone-950) and the start of the fade, so it looks the
  // same as its section. A nested header stays below the header of its parent, and goes
  // under it.
  // Both stay under the panel resize handle (z-20), so a drag there does not toggle a section.
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="editor-section border-t border-ink/10 px-4 bg-[linear-gradient(rgb(var(--ink)/calc(0.03*var(--section-glow))),transparent_3rem)] bg-[length:100%_3rem] bg-no-repeat [details_&]:-mx-4"
    >
      <summary
        ref={summary}
        onClick={(event) => {
          // Option-click resets the section, as in Lightroom, and keeps it open or closed.
          if (section && event.altKey) {
            event.preventDefault()
            reset()
          }
          animateDetails(event)
        }}
        onContextMenu={(event) => {
          if (!section) return
          event.preventDefault()
          menu(event.clientX, event.clientY)
        }}
        onKeyDown={(event) => {
          if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
          if (!section) return
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          menu(bounds.left, bounds.bottom)
        }}
        className="control-label sticky top-0 z-[2] -mx-4 flex h-10 cursor-pointer list-none items-center gap-1.5 bg-[color:color-mix(in_srgb,rgb(var(--tone-900))_30%,rgb(var(--tone-950)))] px-4 font-bold tracking-[0.16em] text-tone-400 transition-colors hover:text-tone-100 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/50 bg-[linear-gradient(rgb(var(--ink)/calc(0.03*var(--section-glow))),transparent_3rem)] [details_details>&]:top-10 [details_details>&]:z-[1] [&::-webkit-details-marker]:hidden"
      >
        {name}
        {info}
        <ChevronDown
          aria-hidden="true"
          className="ml-auto h-3.5 w-3.5 text-tone-500 transition-[color,transform] [summary:hover>&]:text-tone-300 [details[open]:not([data-closing])>summary>&]:rotate-180"
        />
      </summary>
      <div className="space-y-3 pb-3 [&>.adjustment+.adjustment]:mt-1">{children}</div>
    </details>
  )
}

/** One-of-many color choice shown as swatches rather than names. */
export function Swatches<T extends string>({
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
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5 py-1">
      {options.map((option) => (
        // The selection rings are inset, so a selected swatch keeps the size of the others.
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.label}
          title={option.label}
          onClick={(event) => {
            onChange(option.value)
            blurOnClick(event)
          }}
          className="h-5 w-5 rounded-full ring-offset-2 ring-offset-tone-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/60 disabled:opacity-40 aria-checked:shadow-[inset_0_0_0_2px_rgb(var(--ink)),inset_0_0_0_4px_rgb(var(--tone-950))]"
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
  mixPicking,
  setMixPicking,
  onNavigate
}: {
  recipe: EditRecipe
  picking: boolean
  setPicking: (value: boolean) => void
  mixPicking?: 0 | 1 | 2 | null
  setMixPicking?: (output: 0 | 1 | 2 | null) => void
  onNavigate: (page: 'emulsion' | 'paper') => void
}): React.JSX.Element {
  // Memo skips the parent's render, so this renders again for a new language.
  useLanguage()
  const [tab, setPanelTab] = useState<(typeof PANEL_TABS)[number][0]>('raw')
  // The white balance and mix pickers live on Grading, so leaving it disarms them.
  const setTab = (next: (typeof PANEL_TABS)[number][0]): void => {
    if (next !== 'grading') {
      setPicking(false)
      setMixPicking?.(null)
    }
    setPanelTab(next)
  }
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  // A DNG has no Foveon settings, and a monochrome DNG has no white balance.
  const foveon = useEditorStore((state) => !state.session || capabilitiesOf(state.session).foveon)
  const whiteBalance = useEditorStore(
    (state) => !state.session || capabilitiesOf(state.session).whiteBalance
  )
  // The RAW channel mix sets the gray mix of monochrome infrared, so it has no filter.
  const monochromeRaw = !!recipe.rawColor && monochromeRawMatrix(recipe.rawColor.matrix)
  const monochrome =
    !!recipe.monochrome ||
    recipe.cameraProfile === 'Monochrome' ||
    monochromeFilm(recipe.film) ||
    monochromeRaw
  const x3i = useEditorStore((state) => state.x3i)
  // While an X3I merges an SFD RAW that it uses, only the SFD RAW section works.
  const pending = useEditorStore(needsX3iMerge)
  const inert = pending ? { inert: '', className: 'opacity-50' } : {}
  // When such a merge starts, Develop shows, because its progress is in the SFD RAW section.
  const [wasPending, setWasPending] = useState(pending)
  if (pending !== wasPending) {
    setWasPending(pending)
    if (pending) setPanelTab('raw')
  }
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
  return (
    <>
      {/* Tabs that share the width, as in the settings header. The selected icon has
          the select color. The gray select color is below 3:1 on the gray surface, so
          there the selected icon keeps the label color. */}
      <div className="px-3 py-2.5">
        <GlassGroup
          kind="tabs"
          id="panel"
          variant="split"
          panelId={(value) => `panel-${value}`}
          display="stacked"
          size="sm"
          className="[&_[data-selected]>svg]:text-select [html[data-theme=gray]_&_[data-selected]>svg]:text-inherit"
          aria-label={t('editor.panels')}
          value={tab}
          onValueChange={setTab}
          items={PANEL_TABS.map(([value, label, icon]) => ({
            value,
            icon,
            label: t(`editor.${label}`)
          }))}
        />
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`panel-tab-${tab}`}>
        {/* The SFD RAW section stays out of the inert part, because it works during a merge.
            It stays mounted on the other tabs, because it starts the merge that a recipe needs. */}
        {x3i && (
          <div hidden={tab !== 'raw'}>
            <Section id="sfdRaw" name={t('editor.sfdRaw')} info={!x3i.processed && <SfdRawInfo />}>
              <SfdRaw recipe={recipe} />
            </Section>
          </div>
        )}
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
                {foveon &&
                  control('fillLight', {
                    min: -2,
                    max: 2,
                    step: 0.1,
                    help: t('editor.fillLightHelp')
                  })}
              </Section>
              <Section
                id="curves"
                name={t('editor.curves')}
                info={<HelpTooltip label={t('editor.curves')} text={t('editor.curveHint')} />}
              >
                <Curves recipe={recipe} />
              </Section>
              <Section id="detail" name={t('editor.detail')}>
                {control('sharpen', { min: 0, max: 100 })}
                {foveon && control('denoise', { min: 0, max: 10, help: t('editor.denoiseHelp') })}
                {foveon && recipe.denoise > 0 && (
                  <DenoiseControls
                    storageId="denoiseAdvanced"
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
              {/* Only a film stock has a print to make. */}
              {recipe.film && (
                <Section id="darkroom" name={t('editor.darkroom')}>
                  {/* A positive (slide) film is viewed directly. Printing it on negative
                      paper inverts it, so offer the papers only to undo that. */}
                  {(!positiveFilm(recipe.film) || !recipe.film.negative) && (
                    <LookPicker kind="paper" recipe={recipe} onOpen={() => onNavigate('paper')} />
                  )}
                  <FilmControls film={recipe.film} />
                </Section>
              )}
              <EffectsSection recipe={recipe} />
            </>
          )}
          {tab === 'grading' && (
            <>
              {whiteBalance && (
                <Section id="whiteBalance" name={t('editor.whiteBalance')}>
                  <WhiteBalanceControls
                    key={`${useEditorStore.getState().session?.sessionId}:${!!recipe.rawColor}`}
                    recipe={recipe}
                    picking={picking}
                    setPicking={setPicking}
                  />
                </Section>
              )}
              {recipe.rawColor && (
                <>
                  <Section
                    id="channels"
                    name={t('editor.rawChannels')}
                    info={
                      <HelpTooltip label={t('editor.rawChannels')} text={t('editor.mixPadHelp')} />
                    }
                  >
                    <RawMatrixControls
                      recipe={recipe}
                      mixPicking={mixPicking}
                      setMixPicking={setMixPicking}
                    />
                  </Section>
                  {!monochromeRaw && (
                    <Section id="channelSwap" name={t('editor.channelSwap')}>
                      <ChannelSwap recipe={recipe} />
                    </Section>
                  )}
                </>
              )}
              {monochrome && !monochromeRaw && (
                <Section
                  id="filter"
                  name={t('editor.filter')}
                  info={
                    <HelpTooltip label={t('editor.filter')} text={t('editor.monochromeHelp')} />
                  }
                >
                  <Swatches
                    label={t('editor.filter')}
                    value={recipe.monochrome?.filter ?? 'neutral'}
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
                </Section>
              )}
              <Section id="color" name={t('editor.color')}>
                {monochrome ? (
                  control('warmth', { value: recipe.warmth ?? 0, track: TEMPERATURE })
                ) : (
                  <>
                    {control('saturation', { track: RAINBOW })}
                    {control('vibrance', { track: RAINBOW, help: t('editor.vibranceHelp') })}
                  </>
                )}
              </Section>
              {monochrome ? (
                <Section id="toneMixer" name={t('editor.toneMixer')}>
                  <ToneMixer recipe={recipe} />
                </Section>
              ) : (
                <>
                  <Section id="colorMixer" name={t('editor.colorMixer')}>
                    <ColorMixer recipe={recipe} />
                  </Section>
                  <Section id="colorWheels" name={t('editor.colorWheels')}>
                    <ColorWheels recipe={recipe} />
                  </Section>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
})

export function EmulsionControls({ recipe }: { recipe: EditRecipe }): React.JSX.Element {
  return <LookPicker kind="film" recipe={recipe} gallery />
}

export const CHANNELS = {
  master: 'conic-gradient(#f87171, #4ade80, #60a5fa, #f87171)',
  red: '#f87171',
  green: '#4ade80',
  blue: '#60a5fa'
} as const

/** Common tone curves. A preset applies to the selected channel. */
const CURVE_PRESETS = {
  linear: [],
  lowContrast: [
    [0.25, 0.29],
    [0.75, 0.71]
  ],
  mediumContrast: [
    [0.25, 0.21],
    [0.75, 0.79]
  ],
  strongContrast: [
    [0.25, 0.16],
    [0.75, 0.84]
  ],
  liftShadows: [[0.25, 0.33]],
  fadedShadows: [
    [0, 0.1],
    [0.25, 0.3]
  ],
  softHighlights: [
    [0.6, 0.6],
    [1, 0.9]
  ],
  matte: [
    [0, 0.1],
    [0.25, 0.3],
    [0.75, 0.75],
    [1, 0.92]
  ],
  brighten: [[0.5, 0.6]],
  darken: [[0.5, 0.4]]
} satisfies Record<string, Array<[number, number]>>
type CurvePreset = keyof typeof CURVE_PRESETS
/** The points of a preset. Points at x = 0 or 1 replace the endpoints. */
const presetPoints = (preset: CurvePreset): CurvePoint[] => {
  const points = new Map<number, number>([
    [0, 0],
    [1, 1]
  ])
  for (const [x, y] of CURVE_PRESETS[preset]) points.set(x, y)
  return [...points].sort(([a], [b]) => a - b).map(([x, y]) => ({ x, y }))
}
const matchPreset = (points: CurvePoint[]): CurvePreset | 'custom' =>
  (Object.keys(CURVE_PRESETS) as CurvePreset[]).find((preset) => {
    const other = presetPoints(preset)
    return (
      other.length === points.length &&
      other.every(
        (p, i) => Math.abs(p.x - points[i].x) < 1e-4 && Math.abs(p.y - points[i].y) < 1e-4
      )
    )
  }) ?? 'custom'

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
  const reset = (): void => {
    setPoints(defaultRecipe().curves[channel])
    setSelected(0)
  }
  // The Qualifier finds the curve input of a preview color: the RGB curve reads its luma.
  const armed = useCurveQualifier((s) => s.armed)
  const hover = useCurveQualifier((s) => s.hover)
  const pick = useCurveQualifier((s) => s.pick)
  const inputOf = (rgb: [number, number, number]): number =>
    curveInput(
      points,
      channel === 'master'
        ? rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
        : rgb[['red', 'green', 'blue'].indexOf(channel)]
    )
  /**
   * What a pick of a color does: select the point at its input, else add one there.
   * The ghost knob shows the same point, so the click lands where the ghost shows.
   */
  const target = (rgb: [number, number, number]): { point: CurvePoint; index: number } | null => {
    const x = inputOf(rgb)
    // As a click on the curve, a point at the same input is selected instead of doubled.
    const index = points.findIndex((p) => Math.abs(p.x - x) <= 0.005)
    if (index >= 0) return { point: points[index], index }
    if (points.length >= 16 || x <= 0.01 || x >= 0.99) return null
    return { point: { x, y: evaluateCurve(points, x) }, index: -1 }
  }
  const ghost = armed && hover ? target(hover)?.point : undefined
  useEffect(() => {
    if (!pick) return
    useCurveQualifier.setState({ pick: null })
    const found = target(pick)
    if (!found || found.index >= 0) {
      if (found) setSelected(found.index)
      return
    }
    const next = [...points, found.point].sort((a, b) => a.x - b.x)
    setPoints(next)
    setSelected(next.indexOf(found.point))
    // The handler reads the current curve when a pick arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick])
  const session = useEditorStore((state) => state.session?.sessionId)
  useEffect(() => () => useCurveQualifier.getState().arm(false), [session])
  const preset = matchPreset(points)
  const silhouette = useHistogramPath(channel)
  const menuId = useId()
  const pad = useRef<HTMLDivElement>(null)
  // The clip follows the pad's 12 px corner radius, in the 200 unit curve box.
  const corner = (12 * 200) / (useElementWidth(pad) || 200)
  const clipId = `curve-clip${useId().replace(/:/g, '')}`
  useEffect(() => () => invalidateNativeMenu(menuId), [menuId, session, channel])
  const position = (event: React.MouseEvent<SVGSVGElement>): CurvePoint => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height))
    }
  }
  const near = (point: CurvePoint): number =>
    points.findIndex((p) => Math.hypot(p.x - point.x, p.y - point.y) < 0.06)
  // On a channel switch, the curve and its points morph from the previous curve.
  const { from, t: morph } = useSwitchTween(channel, points)
  const blend = (x: number, y: number, curve: CurvePoint[] = from): number =>
    morph === 1 ? y : evaluateCurve(curve, x) + (y - evaluateCurve(curve, x)) * morph
  const path =
    morph === 1
      ? curvePath(points)
      : Array.from({ length: 101 }, (_, i) => {
          const x = i / 100
          return `${i ? 'L' : 'M'} ${x * 200} ${(1 - blend(x, evaluateCurve(points, x))) * 200}`
        }).join(' ')
  return (
    <>
      <div className="tool-row flex flex-wrap items-center gap-2">
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
        <Select<CurvePreset | 'custom'>
          aria-label={t('editor.curvePreset')}
          className="tool-row-select min-w-0 flex-1"
          value={preset}
          options={[
            ...(preset === 'custom'
              ? [
                  {
                    value: 'custom' as const,
                    label: t('editor.curvePreset.custom'),
                    disabled: true
                  }
                ]
              : []),
            ...(Object.keys(CURVE_PRESETS) as CurvePreset[]).map((value) => ({
              value,
              label: t(`editor.curvePreset.${value}`)
            }))
          ]}
          onValueChange={(value) => {
            if (value === 'custom') return
            setPoints(presetPoints(value))
            setSelected(0)
          }}
        />
        <div className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('editor.curveQualifier')}
            title={t('editor.curveQualifierHelp')}
            aria-pressed={armed}
            onClick={() => useCurveQualifier.getState().arm(!armed)}
          >
            <Pipette className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('editor.resetCurve')}
            title={t('editor.resetCurve')}
            onClick={reset}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div
        ref={pad}
        className="glass-well relative rounded-xl"
        data-spectrum={recipe.rawColor ? 'full' : 'visible'}
        data-rgb={channel === 'master' || undefined}
        data-qualifying={armed || undefined}
        style={
          { '--glow': channel === 'master' ? undefined : CHANNELS[channel] } as React.CSSProperties
        }
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          event.currentTarget.style.setProperty('--light-x', `${event.clientX - box.left}px`)
          event.currentTarget.style.setProperty('--light-y', `${event.clientY - box.top}px`)
        }}
      >
        <div aria-hidden="true" className="mix-light" />
        <svg
          viewBox="0 0 200 200"
          aria-label={t('editor.curves')}
          role="group"
          // After a click, the curve keeps the focus, so Delete removes the selected point.
          tabIndex={-1}
          className="relative block aspect-square w-full touch-none overflow-visible outline-none"
          onContextMenu={(event) => {
            event.preventDefault()
            // On a point, the menu removes it. Elsewhere, it resets the curve.
            const index = near(position(event))
            const onPoint = index >= 0 && !endpoint(index)
            const items = [
              onPoint
                ? { value: 'remove', label: t('editor.removePoint') }
                : { value: 'reset', label: t('editor.resetCurve') }
            ]
            void showNativeMenu(
              { id: menuId, x: event.clientX, y: event.clientY, items },
              (value) => (value === 'remove' ? remove(index) : reset())
            ).catch((error: unknown) => console.error('Could not open native context menu', error))
          }}
          onPointerDown={(event) => {
            // A secondary click opens the menu; it does not add a point.
            if (event.button > 0 || event.ctrlKey) return
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
          onPointerUp={(event) => {
            drag.current = null
            commit()
            event.currentTarget.focus({ preventScroll: true })
          }}
          onPointerCancel={(event) => {
            drag.current = null
            commit()
            event.currentTarget.focus({ preventScroll: true })
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return
            // The queue must not remove the photo.
            event.preventDefault()
            remove(active)
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
          {/* The pad clips the grid, the histogram and the curve. The points can go past its edges. */}
          <clipPath id={clipId}>
            <rect width="200" height="200" rx={corner} />
          </clipPath>
          <g clipPath={`url(#${clipId})`}>
            {[50, 100, 150].map((v) => (
              <path key={v} d={`M${v} 0V200 M0 ${v}H200`} className="stroke-ink" opacity="0.07" />
            ))}
            {silhouette && (
              <path
                d={silhouette}
                className={channel === 'master' ? 'fill-ink' : undefined}
                fill={channel === 'master' ? undefined : CHANNELS[channel]}
                opacity={channel === 'master' ? 0.1 : 0.18}
              />
            )}
            <path d="M0 200L200 0" className="stroke-ink" opacity="0.15" strokeDasharray="3 4" />
            <path
              d={path}
              fill="none"
              className="curve-line"
              style={{
                stroke: channel === 'master' ? 'rgb(var(--ink) / 0.85)' : CHANNELS[channel]
              }}
              strokeWidth="2"
            />
          </g>
          <g className="curve-handles">
            {morph < 1 &&
              from.map((point, index) => (
                <circle
                  key={`from-${index}`}
                  aria-hidden="true"
                  pointerEvents="none"
                  cx={point.x * 200}
                  cy={(1 - (point.y + (evaluateCurve(points, point.x) - point.y) * morph)) * 200}
                  r="3.5"
                  fill="#888"
                  stroke="#000"
                  strokeWidth="1.5"
                  opacity={1 - morph}
                />
              ))}
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
                cy={(1 - blend(point.x, point.y)) * 200}
                opacity={morph}
                r={index === active ? 4.5 : 3.5}
                fill={index === active ? '#fff' : '#888'}
                stroke="#000"
                strokeWidth="1.5"
                className="outline-none focus-visible:stroke-white"
                onFocus={() => setSelected(index)}
                onKeyDown={(event) => {
                  blurOnEnter(event)
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
                  }
                }}
              />
            ))}
            {ghost && (
              <circle
                aria-hidden="true"
                pointerEvents="none"
                cx={ghost.x * 200}
                cy={(1 - ghost.y) * 200}
                r="5"
                fill="#fff"
                stroke="#000"
                strokeWidth="1.5"
                strokeDasharray="2 1.5"
              />
            )}
          </g>
        </svg>
      </div>
      {armed && (
        <p role="status" className="text-xs text-tone-200">
          {t('editor.curveQualifierHint')}
        </p>
      )}
    </>
  )
}

/**
 * The histogram of the edited preview for a curve channel, as a filled path in the 200 unit
 * curve box. The RGB channel combines red, green and blue.
 */
function useHistogramPath(channel: keyof EditRecipe['curves']): string | undefined {
  const url = useEditorStore((state) => state.preview?.url)
  // Reading the picture waits until the developing cloud leaves.
  const image = useScopeImage(useContext(DevelopingCloud) ? undefined : url)
  // Keep the last silhouette while the next preview decodes.
  const last = useRef<string>()
  const channels = useMemo(
    () => (image && image !== 'loading' ? histogram(image) : undefined),
    [image]
  )
  const path = useMemo(() => {
    if (!channels) return undefined
    const [r, g, b] = channels
    const bins =
      channel === 'master'
        ? Array.from(r, (v, i) => v + g[i] + b[i])
        : Array.from(channels[['red', 'green', 'blue'].indexOf(channel)])
    // Clipped blacks and whites must not flatten the rest.
    const max = Math.max(1, ...bins.slice(1, 255))
    return `M0 200 ${bins.map((v, i) => `L${(i / 255) * 200} ${200 - Math.min(1, v / max) * 200}`).join(' ')} L200 200Z`
  }, [channels, channel])
  if (path) last.current = path
  return image === 'loading' ? last.current : path
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
