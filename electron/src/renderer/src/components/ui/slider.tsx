import * as SliderPrimitive from '@radix-ui/react-slider'
import { cn } from '../../lib/cn'

export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  onValueChange: (value: number) => void
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  disabled,
  onValueChange
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
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-white/15">
        <SliderPrimitive.Range className="absolute h-full bg-blue-600" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          'block h-4 w-4 rounded-full border border-black/20 bg-white shadow',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60'
        )}
      />
    </SliderPrimitive.Root>
  )
}
