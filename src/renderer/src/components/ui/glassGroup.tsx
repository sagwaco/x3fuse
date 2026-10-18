import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface GlassGroupItem<T extends string> {
  value: T
  /** The visible text, and the accessible name when only the icon shows. */
  label: string
  icon?: LucideIcon
  /** The tooltip. An icon-only item uses its label when this is not set. */
  title?: string
  keyshortcuts?: string
  disabled?: boolean
}

export interface GlassGroupProps<T extends string> {
  value: T
  items: readonly GlassGroupItem<T>[]
  onValueChange: (value: T) => void
  'aria-label': string
  /**
   * `tabs`: a tablist. Arrow keys, Home and End move the selection and the focus,
   * and only the selected tab is in the tab order. Requires `id` and `panelId`.
   * `buttons`: a group of pressed buttons, each in the tab order.
   */
  kind?: 'tabs' | 'buttons'
  /** Tab ids are `${id}-tab-${value}`. */
  id?: string
  /** The id of the panel that a tab controls. */
  panelId?: (value: T) => string
  /** `label`: text. `icon`: icon only. `stacked`: icon above text, as in a toolbar. */
  display?: 'label' | 'icon' | 'stacked'
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
}

/**
 * One choice of many, as tabs or buttons. A background holds the whole group, and
 * the selected item sits on a fill.
 */
export function GlassGroup<T extends string>({
  value,
  items,
  onValueChange,
  'aria-label': label,
  kind = 'buttons',
  id,
  panelId,
  display = 'label',
  size = 'md',
  disabled,
  className
}: GlassGroupProps<T>): React.JSX.Element {
  const tabs = kind === 'tabs'
  const tabId = (item: T): string | undefined => (id ? `${id}-tab-${item}` : undefined)
  const move = (event: React.KeyboardEvent, index: number): void => {
    if (!tabs) return
    const count = items.length
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % count
        : event.key === 'ArrowLeft'
          ? (index + count - 1) % count
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? count - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    const target = items[next].value
    onValueChange(target)
    const element = tabId(target)
    if (element) document.getElementById(element)?.focus()
  }
  return (
    <div
      role={tabs ? 'tablist' : 'group'}
      aria-label={label}
      className={cn('inline-flex rounded-lg bg-ink/5 p-0.5', className)}
    >
      {items.map((item, index) => {
        const selected = item.value === value
        const Icon = item.icon
        return (
          <button
            key={item.value}
            id={tabs ? tabId(item.value) : undefined}
            type="button"
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? selected : undefined}
            aria-controls={tabs ? panelId?.(item.value) : undefined}
            aria-pressed={tabs ? undefined : selected}
            tabIndex={tabs ? (selected ? 0 : -1) : undefined}
            aria-label={display === 'icon' ? item.label : undefined}
            title={item.title ?? (display === 'icon' ? item.label : undefined)}
            aria-keyshortcuts={item.keyshortcuts}
            disabled={disabled || item.disabled}
            data-selected={selected || undefined}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'flex flex-1 items-center justify-center rounded-md text-tone-300 hover:text-tone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/60 disabled:opacity-40 data-[selected]:bg-ink/15 data-[selected]:text-ink',
              display === 'stacked' ? 'flex-col gap-1' : 'gap-1.5',
              size === 'sm' ? 'h-6 min-w-6 px-1.5 text-[10px]' : 'h-7 min-w-7 px-2.5 text-[11px]',
              display === 'stacked' && 'h-auto py-1.5'
            )}
          >
            {Icon && (
              <Icon
                aria-hidden="true"
                className={display === 'stacked' ? 'h-5 w-5' : 'h-3.5 w-3.5'}
                strokeWidth={display === 'stacked' ? 1.75 : 2}
              />
            )}
            {display !== 'icon' && <span className="truncate">{item.label}</span>}
          </button>
        )
      })}
    </div>
  )
}
