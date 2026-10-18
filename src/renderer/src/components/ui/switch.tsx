import { useState } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '../../lib/cn'

/** The track look, for the switch and for its copy in the glass lens. */
const TRACK = cn(
  'rounded-full border transition-colors',
  'data-[state=checked]:border-yellow-400 data-[state=checked]:bg-yellow-400',
  'data-[state=unchecked]:border-transparent data-[state=unchecked]:bg-ink/20'
)

/** Milliseconds that the knob stays glass after a release. */
const HOLD = 200

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
  // The knob shows as glass while the pointer presses it, and for HOLD ms after.
  const [pressed, setPressed] = useState(false)
  return (
    <SwitchPrimitive.Root
      id={id}
      data-pressed={pressed || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        setPressed(true)
        const release = (): void => {
          window.removeEventListener('pointerup', release)
          window.removeEventListener('pointercancel', release)
          setTimeout(() => setPressed(false), HOLD)
        }
        window.addEventListener('pointerup', release)
        window.addEventListener('pointercancel', release)
      }}
      aria-label={label}
      checked={checked}
      onCheckedChange={onCheckedChange}
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
          'data-[state=checked]:bg-black data-[state=unchecked]:bg-tone-400'
        )}
      >
        <span className="glass-lens">
          <span data-state={checked ? 'checked' : 'unchecked'} className={cn(TRACK, 'w-9')} />
        </span>
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}
