import { useState } from 'react'
import { Flag as FlagIcon, FlagOff, Star } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { cull, cullTargets } from '../hooks/useCulling'
import { cn } from '../lib/cn'
import { withShortcut } from '../lib/shortcut'
import { t } from '../lib/strings'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * Five star buttons. Hover or focus fills the stars up to that star. Selecting the current
 * rating again clears it.
 */
export function StarPicker({
  value,
  onChange,
  shortcuts = false
}: {
  value: number
  onChange: (stars: number) => void
  /** Shows the rating keys in the tooltips. */
  shortcuts?: boolean
}): React.JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null)
  const shown = hovered ?? value
  return (
    <div className="flex items-center" onPointerLeave={() => setHovered(null)}>
      {[1, 2, 3, 4, 5].map((stars) => {
        const label = t('cull.rating', { stars })
        return (
          <button
            key={stars}
            type="button"
            aria-label={label}
            title={shortcuts ? withShortcut(label, String(stars)) : label}
            aria-keyshortcuts={shortcuts ? String(stars) : undefined}
            aria-pressed={value === stars}
            onClick={() => onChange(value === stars ? 0 : stars)}
            onPointerEnter={() => setHovered(stars)}
            onFocus={() => setHovered(stars)}
            onBlur={() => setHovered(null)}
            className="rounded p-1 outline-none hover:bg-ink/10 focus-visible:ring-1 focus-visible:ring-ink/40"
          >
            <Star
              aria-hidden="true"
              className={cn(
                'h-3.5 w-3.5',
                stars <= shown ? 'fill-current text-tone-100' : 'text-tone-500'
              )}
            />
          </button>
        )
      })}
    </div>
  )
}

/** The info panel's flag and rating controls for the photos that culling keys change. */
export function CullControls(): React.JSX.Element | null {
  const mode = useSettingsStore((s) => s.settings.queueViewMode)
  const targets = useQueueStore(useShallow((s) => cullTargets(s, mode, 'queue')))
  if (!targets.length) return null
  const flags = new Set(targets.map((file) => file.flag ?? 'unflagged'))
  const ratings = new Set(targets.map((file) => file.rating ?? 0))
  const flag = flags.size === 1 ? [...flags][0] : undefined
  return (
    <div className="flex items-center justify-between border-b border-ink/10 px-2 py-1.5">
      <div className="flex items-center">
        {(['pick', 'reject'] as const).map((value) => {
          const Icon = value === 'pick' ? FlagIcon : FlagOff
          const key = value === 'pick' ? 'Z' : 'X'
          return (
            <button
              key={value}
              type="button"
              aria-label={t(`cull.${value}`)}
              title={withShortcut(t(`cull.${value}`), key)}
              aria-keyshortcuts={key}
              aria-pressed={flag === value}
              onClick={() => cull({ flag: value }, { toggle: true })}
              className="rounded p-1 outline-none hover:bg-ink/10 focus-visible:ring-1 focus-visible:ring-ink/40"
            >
              <Icon
                aria-hidden="true"
                className={cn('h-3.5 w-3.5', value === 'pick' && flag === value && 'fill-current')}
              />
            </button>
          )
        })}
      </div>
      <StarPicker
        value={ratings.size === 1 ? [...ratings][0] : 0}
        onChange={(rating) => cull({ rating })}
        shortcuts
      />
    </div>
  )
}
