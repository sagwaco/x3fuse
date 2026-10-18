import { useCallback, useContext, useEffect, useId, useRef } from 'react'
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

/** Clamps a dot to the unit disc. Rounding keeps sidecars short and stays inside the disc. */
function inDisc(x: number, y: number): Pick<Wheel, 'x' | 'y'> {
  const scale = Math.min(1, 1 / Math.hypot(x, y))
  const round = (v: number): number => Math.round(v * scale * 1e4) / 1e4
  return { x: round(x), y: round(y) }
}

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
  const wheel = (zone: Zone): React.JSX.Element => (
    <WheelControl
      label={t(ZONE_LABELS[zone])}
      value={wheels[zone]}
      disabled={disabled}
      colorless={colorless}
      change={(value, save) => update({ [zone]: value }, save)}
      commit={commit}
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

function WheelControl({
  label,
  value,
  disabled,
  colorless,
  change,
  commit
}: {
  label: string
  value: Wheel
  disabled: boolean
  /** Turns off the hue disc only. The luminance slider stays on. */
  colorless: boolean
  change: (value: Wheel, save: boolean) => void
  commit: () => void
}): React.JSX.Element {
  // The pointer that drags the dot. Other pointers do nothing until it lets go.
  const pointer = useRef<number | null>(null)
  // While Shift is held in a drag, the hue (in radians) that the dot keeps.
  const locked = useRef<number | null>(null)
  const description = useId()
  const off = disabled || colorless
  const reset = (): void => change({ ...value, x: 0, y: 0 }, true)
  // The angle of the pointer from the center sets the hue, and its distance sets the
  // strength. Past the rim, the dot follows the rim. With Shift, the dot moves only on
  // the line from the center through the hue it had when Shift went down.
  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect()
    let x = ((event.clientX - box.left) / box.width) * 2 - 1
    let y = 1 - ((event.clientY - box.top) / box.height) * 2
    if (!event.shiftKey) locked.current = null
    else if (locked.current === null && (value.x || value.y)) {
      locked.current = Math.atan2(value.y, value.x)
    }
    if (locked.current !== null) {
      const [ux, uy] = [Math.cos(locked.current), Math.sin(locked.current)]
      const along = Math.max(0, x * ux + y * uy)
      ;[x, y] = [along * ux, along * uy]
    }
    change({ ...value, ...inDisc(x, y) }, false)
  }
  const end = useCallback((): void => {
    locked.current = null
    if (pointer.current === null) return
    pointer.current = null
    commit()
  }, [commit])
  const release = (event: React.PointerEvent): void => {
    if (event.pointerId === pointer.current) end()
  }
  // A drag also ends when the wheel turns off or unmounts.
  useEffect(() => end, [off, end])
  const hue = Math.round(((Math.atan2(value.y, value.x) * 180) / Math.PI + 360) % 360)
  const strength = Math.round(Math.hypot(value.x, value.y) * 100)
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
          className="relative aspect-square w-full max-w-[80px] touch-none rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/60"
          style={{ background: DISC }}
          onPointerDown={(event) => {
            // Only a primary press drags. Control-click is a secondary click on macOS.
            if (off || pointer.current !== null || event.button !== 0 || event.ctrlKey) return
            event.currentTarget.setPointerCapture(event.pointerId)
            event.currentTarget.focus()
            pointer.current = event.pointerId
            move(event)
          }}
          onPointerMove={(event) => {
            if (event.pointerId === pointer.current && !off) move(event)
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onLostPointerCapture={release}
          onDoubleClick={() => {
            if (!off) reset()
          }}
          onKeyDown={(event) => {
            if (off) return
            const step = event.shiftKey ? 0.1 : 0.02
            const [dx, dy] =
              {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, step],
                ArrowDown: [0, -step]
              }[event.key] ?? []
            if (dx !== undefined) {
              event.preventDefault()
              change({ ...value, ...inDisc(value.x + dx, value.y + dy) }, true)
            } else if (event.key === 'Delete' || event.key === 'Backspace') {
              event.preventDefault()
              reset()
            }
          }}
        >
          <span id={description} className="sr-only">
            {`${t('editor.hue')} ${hue}°, ${strength}%`}
          </span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_2px_rgb(0_0_0/0.7)]"
            style={{ left: `${(1 + value.x) * 50}%`, top: `${(1 - value.y) * 50}%` }}
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
