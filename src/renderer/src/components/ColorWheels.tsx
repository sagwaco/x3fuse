import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  DEFAULT_WHEELS,
  monochromeFilm,
  type ColorWheels as Wheels,
  type EditRecipe,
  type Wheel
} from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { DevelopingCloud } from '../lib/developingCloud'
import { useQueueStore } from '../stores/queueStore'
import { appInfo } from '../lib/appInfo'
import { dragTo, polar, type WheelDrag, type WheelPosition } from '../lib/colorWheel'
import { invalidateNativeMenu, showNativeMenu } from '../lib/nativeMenu'
import { t } from '../lib/strings'
import { Slider } from './ui/slider'
import { cn } from '../lib/cn'
import { Adjustment } from './EditorControls'

type Zone = 'shadows' | 'midtones' | 'highlights'
const ZONE_LABELS: Record<Zone, string> = {
  shadows: 'editor.shadows',
  midtones: 'editor.midtones',
  highlights: 'editor.highlights'
}
// Red at the right, then counterclockwise through yellow and green, as the renderer
// reads the dot's angle. CSS conic angles turn clockwise from the top.
const DISC = [
  'radial-gradient(closest-side, #fff, rgb(255 255 255 / 0))',
  `conic-gradient(from 90deg, ${[0, 300, 240, 180, 120, 60, 0].map((h) => `hsl(${h} 90% 55%)`).join(', ')})`
].join(', ')
/** A wheel that the context menu copied, for this session. */
let copied: Wheel | null = null

/** Three-way color grading: Midtones above, Shadows and Highlights below. */
export function ColorWheels({ recipe }: { recipe: EditRecipe }): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const cloud = useContext(DevelopingCloud)
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const inactive = useEditorStore(
    (state) => state.before || state.loading || state.closing || !state.preview
  )
  const disabled = cloud || busy || inactive
  // The output pass makes B&W looks neutral, so a tint would not show.
  const colorless = !!recipe.monochrome || monochromeFilm(recipe.film)
  const wheels = recipe.wheels ?? DEFAULT_WHEELS
  const update = (patch: Partial<Wheels>, save = true): void =>
    change({ wheels: { ...wheels, ...patch } }, save)
  // A menu acts on the values when an item is chosen. It closes when the photo changes
  // or the wheels turn off.
  const latest = useRef({ wheels, disabled })
  latest.current = { wheels, disabled }
  const menuId = useId()
  const session = useEditorStore((state) => state.session?.sessionId)
  useEffect(() => () => invalidateNativeMenu(menuId), [menuId, session, disabled])
  const menu = (zone: Zone, x: number, y: number): void => {
    const items = [
      { value: 'reset', label: t('editor.resetWheel') },
      { value: 'resetAll', label: t('editor.resetWheels') },
      { value: 'copy', label: t('editor.copyWheel'), separatorBefore: true },
      { value: 'paste', label: t('editor.pasteWheel'), disabled: !copied }
    ]
    void showNativeMenu({ id: menuId, x, y, items }, (value) => {
      const { wheels: now, disabled: off } = latest.current
      if (off) return
      const set = (patch: Partial<Wheels>): void => change({ wheels: { ...now, ...patch } }, true)
      if (value === 'reset') set({ [zone]: DEFAULT_WHEELS[zone] })
      else if (value === 'resetAll') {
        const { shadows, midtones, highlights } = DEFAULT_WHEELS
        set({ shadows, midtones, highlights })
      } else if (value === 'copy') copied = now[zone]
      else if (value === 'paste' && copied) set({ [zone]: copied })
    }).catch((error: unknown) => console.error('Could not open native context menu', error))
  }
  const wheel = (zone: Zone): React.JSX.Element => (
    <WheelControl
      label={t(ZONE_LABELS[zone])}
      value={wheels[zone]}
      disabled={disabled}
      colorless={colorless}
      change={(value, save) => update({ [zone]: value }, save)}
      commit={commit}
      menu={(x, y) => menu(zone, x, y)}
    />
  )
  return (
    <>
      <div className="grid grid-cols-2 gap-x-3 gap-y-4 pt-1">
        <div className="col-span-2 mx-auto w-[calc(50%-0.375rem)]">{wheel('midtones')}</div>
        {wheel('shadows')}
        {wheel('highlights')}
      </div>
      <Adjustment
        label={t('editor.blending')}
        value={wheels.blending}
        min={0}
        max={100}
        change={(blending, save) => update({ blending }, save)}
        reset={() => update({ blending: DEFAULT_WHEELS.blending })}
        commit={commit}
      />
      <Adjustment
        label={t('editor.balance')}
        value={wheels.balance}
        change={(balance, save) => update({ balance }, save)}
        reset={() => update({ balance: DEFAULT_WHEELS.balance })}
        commit={commit}
      />
    </>
  )
}

const KNOB =
  "absolute -translate-x-1/2 -translate-y-1/2 rounded-full before:absolute before:-inset-1.5 before:content-['']"

function WheelControl({
  label,
  value,
  disabled,
  colorless,
  change,
  commit,
  menu
}: {
  label: string
  value: Wheel
  disabled: boolean
  /** Turns off the hue disc only. The luminance slider stays on. */
  colorless: boolean
  change: (value: Wheel, save: boolean) => void
  commit: () => void
  /** Opens the wheel's context menu at this point of the window. */
  menu: (x: number, y: number) => void
}): React.JSX.Element {
  // The drag of the pointer that pressed first. Other pointers do nothing until it lets go.
  const drag = useRef<WheelDrag | null>(null)
  const [guide, setGuide] = useState<number | null>(null)
  const description = useId()
  const off = disabled || colorless
  // At zero saturation, x and y hold no hue, so the wheel keeps it in `hue`.
  const colored = value.x !== 0 || value.y !== 0
  const hue = colored ? Math.atan2(value.y, value.x) : (value.hue ?? 0)
  const saturation = Math.min(1, Math.hypot(value.x, value.y))
  const set = (next: WheelPosition, save: boolean): void => {
    const rest: Wheel = { ...value }
    delete rest.hue
    const kept = Math.round(Math.atan2(Math.sin(next.hue), Math.cos(next.hue)) * 1e4) / 1e4
    const wheel: Wheel =
      next.x || next.y || !kept
        ? { ...rest, x: next.x, y: next.y }
        : { ...rest, x: 0, y: 0, hue: kept }
    if (wheel.x !== value.x || wheel.y !== value.y || wheel.hue !== value.hue) change(wheel, save)
  }
  const point = (event: React.MouseEvent<HTMLElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect()
    return [
      ((event.clientX - box.left) / box.width) * 2 - 1,
      1 - ((event.clientY - box.top) / box.height) * 2
    ]
  }
  const mac = appInfo.platform === 'darwin'
  const follow = (event: React.PointerEvent<HTMLElement>): void => {
    const keys = {
      shift: event.shiftKey,
      fine: event.altKey,
      hueOnly: mac ? event.metaKey : event.ctrlKey
    }
    const next = dragTo(drag.current!, point(event), keys, { x: value.x, y: value.y, hue })
    setGuide(next.guide)
    set(next, false)
  }
  const end = useCallback((): void => {
    setGuide(null)
    if (drag.current === null) return
    drag.current = null
    commit()
  }, [commit])
  const release = (event: React.PointerEvent): void => {
    if (event.pointerId === drag.current?.pointer) end()
  }
  // A drag also ends when the wheel turns off or unmounts.
  useEffect(() => end, [off, end])
  // At high strength the knobs overlap. Then a press outside the rim takes the outer one.
  const knob = (event: React.MouseEvent<HTMLElement>): string | undefined => {
    const pressed = (event.target as Element).closest('[data-knob]')?.getAttribute('data-knob')
    if (!pressed || saturation < 0.8) return pressed ?? undefined
    return Math.hypot(...point(event)) >= 1 ? 'outer' : 'inner'
  }
  const rim = (r: number, angle: number): React.CSSProperties => ({
    left: `${(1 + r * Math.cos(angle)) * 50}%`,
    top: `${(1 - r * Math.sin(angle)) * 50}%`
  })
  const degrees = Math.round(((hue * 180) / Math.PI + 360) % 360)
  return (
    <div className="space-y-2">
      <p className={cn('control-label text-center', disabled && 'opacity-40')}>{label}</p>
      <div className={cn('flex justify-center', off && 'opacity-40')}>
        <div
          role="application"
          aria-roledescription={t('editor.colorWheel')}
          tabIndex={off ? -1 : 0}
          aria-label={label}
          aria-describedby={description}
          aria-disabled={off || undefined}
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Delete Shift+Delete"
          className="relative aspect-square w-full max-w-[80px] touch-none rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/60"
          style={{ background: DISC }}
          onPointerDown={(event) => {
            // Only a primary press drags. Control-click is a secondary click on macOS.
            if (off || drag.current || event.button !== 0 || (mac && event.ctrlKey)) return
            event.currentTarget.setPointerCapture(event.pointerId)
            event.currentTarget.focus()
            const p = point(event)
            const pressed = knob(event)
            // A press on a knob grabs it where it is. A press elsewhere moves the inner
            // knob to the pointer. A press on the inner knob keeps its hue until the
            // pointer leaves the hue line, except in fine adjust.
            drag.current = {
              pointer: event.pointerId,
              outer: pressed === 'outer',
              at:
                pressed === 'inner'
                  ? [value.x, value.y]
                  : pressed === 'outer'
                    ? [Math.cos(hue), Math.sin(hue)]
                    : p,
              last: p,
              saturation: pressed === 'outer' ? saturation : null,
              hard: null,
              soft: pressed === 'inner' && !event.altKey ? hue : null
            }
            follow(event)
          }}
          onPointerMove={(event) => {
            if (event.pointerId === drag.current?.pointer && !off) follow(event)
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onLostPointerCapture={release}
          onDoubleClick={(event) => {
            if (off) return
            // The outer knob resets the hue. Elsewhere, the saturation resets.
            if (knob(event) === 'outer') set({ ...polar(saturation, 0), hue: 0 }, true)
            else set({ x: 0, y: 0, hue }, true)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            if (!disabled) menu(event.clientX, event.clientY)
          }}
          onKeyDown={(event) => {
            if (off) return
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault()
              const box = event.currentTarget.getBoundingClientRect()
              menu(box.left, box.bottom)
              return
            }
            // Left and right turn the hue, up and down change the strength. Shift takes
            // larger steps. Delete resets the strength, and Shift+Delete the hue.
            const big = event.shiftKey
            const [turn, more] =
              {
                ArrowLeft: [big ? -10 : -2, 0],
                ArrowRight: [big ? 10 : 2, 0],
                ArrowUp: [0, big ? 0.1 : 0.02],
                ArrowDown: [0, big ? -0.1 : -0.02]
              }[event.key] ?? []
            if (turn !== undefined) {
              event.preventDefault()
              const next = hue + (turn * Math.PI) / 180
              set({ ...polar(Math.max(0, Math.min(1, saturation + more)), next), hue: next }, true)
            } else if (event.key === 'Delete' || event.key === 'Backspace') {
              event.preventDefault()
              if (event.shiftKey) set({ ...polar(saturation, 0), hue: 0 }, true)
              else set({ x: 0, y: 0, hue }, true)
            }
          }}
        >
          <span id={description} className="sr-only">
            {`${t('editor.hue')} ${degrees}°, ${Math.round(saturation * 100)}%`}
          </span>
          {guide !== null && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 h-px w-1/2 origin-left bg-white/90 shadow-[0_0_0_0.5px_rgb(0_0_0/0.4)]"
              style={{ rotate: `${-guide}rad` }}
            />
          )}
          {/* The outer knob shows the hue on the rim, in its color. */}
          <span
            aria-hidden="true"
            data-knob="outer"
            className={cn(KNOB, 'h-2.5 w-2.5 shadow-[0_0_0_2px_#fff,0_0_0_3px_rgb(0_0_0/0.5)]')}
            style={{ ...rim(1, hue), background: `hsl(${degrees} 90% 55%)` }}
          />
          {/* The inner knob is hollow, so the color under it shows. */}
          <span
            aria-hidden="true"
            data-knob="inner"
            className={cn(
              KNOB,
              'h-3 w-3 border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.6),inset_0_0_0_1px_rgb(0_0_0/0.6)]'
            )}
            style={rim(saturation, hue)}
          />
        </div>
      </div>
      {/* The button resets the whole wheel: its color and its luminance. */}
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Slider
            aria-label={`${label} ${t('editor.luminance')}`}
            disabled={disabled}
            value={value.luminance}
            min={-100}
            max={100}
            onValueChange={(luminance) => change({ ...value, luminance }, false)}
            onValueCommit={commit}
            onReset={() => change({ ...value, luminance: 0 }, true)}
          />
        </div>
        <button
          type="button"
          disabled={disabled}
          aria-label={`${t('editor.resetWheel')}: ${label}`}
          title={t('editor.resetWheel')}
          className="shrink-0 rounded text-tone-500 hover:text-tone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/60 disabled:opacity-40"
          onClick={() => change({ x: 0, y: 0, luminance: 0 }, true)}
        >
          <RotateCcw aria-hidden="true" className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}
