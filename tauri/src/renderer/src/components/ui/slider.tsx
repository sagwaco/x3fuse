import * as SliderPrimitive from '@radix-ui/react-slider'
import { cn } from '../../lib/cn'

export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  onValueChange: (value: number) => void
  onValueCommit?: (value: number) => void
  onReset?: () => void
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
  'aria-label': label
}: SliderProps): React.JSX.Element {
  return (
    <SliderPrimitive.Root
      className={cn(
        'relative flex w-full touch-none select-none items-center',
        disabled && 'opacity-50'
      )}
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(v) => onValueChange(v[0])}
      onValueCommit={(v) => onValueCommit?.(v[0])}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-white/15">
        <SliderPrimitive.Range className="absolute h-full bg-blue-600" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={label}
        onDoubleClick={(event) => {
          if (disabled || !onReset) return
          event.preventDefault()
          event.stopPropagation()
          onReset()
        }}
        className={cn(
          'block h-4 w-4 rounded-full border border-black/20 bg-white shadow',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60'
        )}
      />
    </SliderPrimitive.Root>
  )
}
