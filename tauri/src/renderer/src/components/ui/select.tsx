import { ChevronDown } from 'lucide-react'
import { NativeMenuButton } from './nativeMenuButton'
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
  'aria-label'?: string
}

export function Select<T extends string>({
  value,
  options,
  onValueChange,
  disabled,
  className,
  'aria-label': label
}: SelectProps<T>): React.JSX.Element {
  return (
    <NativeMenuButton
      disabled={disabled}
      aria-label={label}
      className={cn(
        'h-8 min-w-[8rem] justify-between gap-2 px-2.5 text-sm font-normal text-neutral-100',
        className
      )}
      items={options.map((option) => ({ ...option, checked: option.value === value }))}
      onSelect={(value) => onValueChange(value as T)}
    >
      {options.find((option) => option.value === value)?.label ?? value}
      <ChevronDown className="h-4 w-4 opacity-60" aria-hidden="true" />
    </NativeMenuButton>
  )
}
