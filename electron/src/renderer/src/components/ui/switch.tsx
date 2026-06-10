import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '../../lib/cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
}

export function Switch({ checked, onCheckedChange, disabled, id }: SwitchProps): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'peer inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full',
        'border border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-blue-600 data-[state=unchecked]:bg-white/15'
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform',
          'data-[state=checked]:translate-x-[17px] data-[state=unchecked]:translate-x-[2px]'
        )}
      />
    </SwitchPrimitive.Root>
  )
}
