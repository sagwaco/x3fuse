import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '../../lib/cn'
import { usePress } from '../../hooks/usePress'
import { blurOnClick } from '../../lib/commitFocus'

/** The track look, for the switch and for its copy in the glass lens. */
const TRACK = cn(
  'rounded-full border transition-colors',
  'data-[state=checked]:border-select data-[state=checked]:bg-select',
  'data-[state=unchecked]:border-transparent data-[state=unchecked]:bg-ink/20'
)

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
  // The knob shows as glass while the pointer presses it, and for a moment after.
  const [pressed, press] = usePress()
  return (
    <SwitchPrimitive.Root
      id={id}
      data-pressed={pressed || undefined}
      onPointerDown={press}
      aria-label={label}
      checked={checked}
      onCheckedChange={onCheckedChange}
      onClick={blurOnClick}
      disabled={disabled}
      className={cn(
        'switch peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center',
        TRACK,
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50',
        'disabled:cursor-not-allowed disabled:opacity-40'
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'switch-knob pointer-events-none relative block h-3.5 w-3.5 rounded-full',
          'data-[state=checked]:bg-on-select data-[state=unchecked]:bg-tone-400'
        )}
      >
        <span className="glass-lens">
          <span data-state={checked ? 'checked' : 'unchecked'} className={cn(TRACK, 'w-9')} />
        </span>
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}
