import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export interface SelectProps<T extends string> {
  value: T
  options: SelectOption<T>[]
  onValueChange: (value: T) => void
  disabled?: boolean
  className?: string
}

export function Select<T extends string>({
  value,
  options,
  onValueChange,
  disabled,
  className
}: SelectProps<T>): React.JSX.Element {
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'inline-flex h-8 min-w-[8rem] items-center justify-between gap-2 rounded-md',
          'border border-white/15 bg-white/5 px-2.5 text-sm text-neutral-100',
          'hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon>
          <ChevronDown className="h-4 w-4 opacity-60" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-50 overflow-hidden rounded-md border border-white/10 bg-neutral-900 shadow-xl',
            'min-w-[var(--radix-select-trigger-width)] py-1'
          )}
        >
          <SelectPrimitive.Viewport>
            {options.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={opt.value}
                className={cn(
                  'relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-3 text-sm',
                  'text-neutral-200 outline-none data-[highlighted]:bg-blue-600 data-[highlighted]:text-white'
                )}
              >
                <span className="absolute left-2 inline-flex items-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="h-3.5 w-3.5" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
