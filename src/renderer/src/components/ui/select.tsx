import { Fragment } from 'react'
import { ArrowRight, ChevronsUpDown } from 'lucide-react'
import { NativeMenuButton } from './nativeMenuButton'
import { cn } from '../../lib/cn'

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SelectProps<T extends string> {
  value: T
  options: SelectOption<T>[]
  onValueChange: (value: T) => void
  disabled?: boolean
  /** Full-width card that shows its aria-label as a caption above the value. */
  card?: boolean
  className?: string
  'aria-label'?: string
}

export function Select<T extends string>({
  value,
  options,
  onValueChange,
  disabled,
  card,
  className,
  'aria-label': label
}: SelectProps<T>): React.JSX.Element {
  return (
    <NativeMenuButton
      disabled={disabled}
      aria-label={label}
      className={cn(
        'h-7 min-w-[8rem] justify-between gap-2 px-2.5 text-[12px] font-normal text-tone-100',
        card && 'h-auto w-full rounded-xl px-3 py-2.5 text-left text-[13px] tracking-[0.12em]',
        className
      )}
      items={options.map((option) => ({ ...option, checked: option.value === value }))}
      onSelect={(value) => onValueChange(value as T)}
    >
      {/* The caption is generated content so the button's text stays the value. */}
      <span
        data-caption={card ? label : undefined}
        className={cn(
          'min-w-0 truncate',
          card &&
            'before:mb-1 before:block before:text-[12px] before:tracking-[0.14em] before:text-tone-500 before:content-[attr(data-caption)]'
        )}
      >
        {/* Native menu items are text, so a label marks an arrow with "→". The button shows an icon. */}
        {(options.find((option) => option.value === value)?.label ?? value)
          .split(' → ')
          .map((part, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <ArrowRight
                  aria-hidden="true"
                  className="mx-1 inline h-3 w-3 align-middle"
                  strokeWidth={2}
                />
              )}
              {part}
            </Fragment>
          ))}
      </span>
      <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
    </NativeMenuButton>
  )
}
