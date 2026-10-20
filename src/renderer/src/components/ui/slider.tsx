import { useRef } from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'
import { cn } from '../../lib/cn'
import { ipc } from '../../lib/ipc'
import { detent } from '../../lib/detent'
import { blurOnEnter } from '../../lib/commitFocus'

/** How close (in pixels) a drag must come to a detent to snap onto it. */
const SNAP_PX = 4
/** Half the thumb width (w-[3px]). Radix uses it to keep the thumb in the track. */
const THUMB_HALF_PX = 1.5
const STEP_KEYS: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowUp: 1,
  PageUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
  PageDown: -1
}

export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  onValueChange: (value: number) => void
  onValueCommit?: (value: number) => void
  onReset?: () => void
  /** CSS background for the track, e.g. a gradient showing what the slider does. */
  track?: string
  /** The value to announce when the position is not the value. */
  valueText?: string
  /** Replaces the arrow and page key steps. `large` is a page key or Shift. */
  onKeyStep?: (direction: 1 | -1, large: boolean) => void
  'aria-label'?: string
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  disabled,
  onValueChange,
  onValueCommit,
  onReset,
  track,
  valueText,
  onKeyStep,
  'aria-label': label
}: SliderProps): React.JSX.Element {
  // Bipolar ranges fill outward from zero, like a camera's exposure scale.
  const percent = (v: number): number =>
    ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * 100
  const origin = percent(min < 0 && max > 0 ? 0 : min)
  const current = percent(value)
  // Haptic detents every 5% of the range (zero on symmetric scales), rounded onto the step grid.
  const detents = Array.from({ length: 21 }, (_, i) =>
    Number((min + Math.round(((max - min) / 20 / step) * i) * step).toFixed(10))
  )
  // Radix moves the thumb in by up to half its width at the ends.
  const inBounds = THUMB_HALF_PX * (1 - current / 50)
  const trackClass = cn('relative w-full grow', track ? 'h-1 rounded-full' : 'h-0.5 bg-ink/15')
  const trackStyle = track ? { background: track } : undefined
  const fill = !track && (
    <div
      className="absolute h-full bg-ink/45"
      style={{
        left: `${Math.min(origin, current)}%`,
        width: `${Math.abs(current - origin)}%`
      }}
    />
  )
  const root = useRef<HTMLSpanElement>(null)
  const drag = useRef<{ last: number; tolerance: number } | null>(null)
  const endDrag = (): void => {
    drag.current = null
    root.current?.querySelector<HTMLElement>('[role="slider"]')?.blur()
  }
  return (
    <SliderPrimitive.Root
      ref={root}
      onPointerDown={() => {
        const width = root.current?.getBoundingClientRect().width || 1
        drag.current = { last: value, tolerance: (SNAP_PX / width) * (max - min) }
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        const direction = STEP_KEYS[event.key]
        if (!direction) return
        // ⌘ or Ctrl with an arrow key is a shortcut, such as Next Photo, and not a step.
        // The shortcut runs before the slider gets the key. Radix skips its own step for a
        // handled key.
        const shortcut = event.metaKey || event.ctrlKey
        if (!onKeyStep && !shortcut) return
        event.preventDefault()
        if (!shortcut) onKeyStep?.(direction, event.shiftKey || event.key.startsWith('Page'))
      }}
      className={cn(
        // The glass lens sizes its track copy with cqw units of the slider.
        'relative flex h-5 w-full touch-none select-none items-center [container-type:inline-size]',
        disabled && 'opacity-40'
      )}
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={([next]) => {
        // Keyboard steps stay exact; only pointer drags snap and click.
        if (!drag.current) return onValueChange(next)
        const { value, click } = detent(drag.current.last, next, detents, drag.current.tolerance)
        drag.current.last = value
        // macOS plays this on Force Touch trackpads; elsewhere it's a no-op.
        if (click) ipc.invoke('haptics:detent').catch(() => {})
        onValueChange(value)
      }}
      onValueCommit={(v) => onValueCommit?.(v[0])}
    >
      <SliderPrimitive.Track className={trackClass} style={trackStyle}>
        {fill}
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        onDoubleClick={(event) => {
          if (disabled || !onReset) return
          event.preventDefault()
          event.stopPropagation()
          onReset()
        }}
        // The keyboard way to reset, as double-click is for the pointer.
        onKeyDown={(event) => {
          blurOnEnter(event)
          if (disabled || !onReset || (event.key !== 'Delete' && event.key !== 'Backspace')) return
          event.preventDefault()
          onReset()
        }}
        // Radix keeps the thumb in the track by its size, so the thumb keeps one size.
        // The knob in it grows about its center on hover.
        className="slider-thumb group relative block h-3.5 w-[3px] focus-visible:outline-none"
      >
        <span
          className={cn(
            'slider-knob pointer-events-none absolute left-1/2 top-1/2 h-3.5 w-[3px] -translate-x-1/2 -translate-y-1/2',
            'rounded-[1px] bg-ink shadow-[0_0_0_2px_rgb(0_0_0/0.85)]',
            // An outline, as the glass hover rules replace the box shadow.
            'group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-ink/60'
          )}
        >
          <span className="glass-lens">
            {/* The track under the knob, which starts at the slider's left edge. */}
            <span
              className="flex w-[100cqw] items-center"
              style={{ left: `calc(50% - ${current}cqw - ${inBounds}px)` }}
            >
              <span className={trackClass} style={trackStyle}>
                {fill}
              </span>
            </span>
          </span>
        </span>
      </SliderPrimitive.Thumb>
    </SliderPrimitive.Root>
  )
}
