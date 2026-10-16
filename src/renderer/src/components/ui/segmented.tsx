import { Button } from './button'

export interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: string }[]
  onValueChange: (value: T) => void
  'aria-label': string
}

export function Segmented<T extends string>({
  value,
  options,
  onValueChange,
  'aria-label': label
}: SegmentedProps<T>): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg bg-ink/5 p-0.5">
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={option.value === value}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}
