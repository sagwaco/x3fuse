import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '../../lib/cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  'aria-label': label
}: SwitchProps): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      id={id}
      aria-label={label}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full',
        'border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50',
        'disabled:cursor-not-allowed disabled:opacity-40',
        'data-[state=checked]:border-white data-[state=checked]:bg-white',
        'data-[state=unchecked]:border-white/20 data-[state=unchecked]:bg-white/[0.03]'
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block h-3.5 w-3.5 rounded-full transition-transform',
          'data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-black',
          'data-[state=unchecked]:translate-x-[2px] data-[state=unchecked]:bg-neutral-400'
        )}
      />
    </SwitchPrimitive.Root>
  )
}
