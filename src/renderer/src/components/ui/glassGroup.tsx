import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { usePress } from '../../hooks/usePress'

/** Milliseconds that the indicator stays glass after a selection change. Keep
 * it at least the slide duration in index.css (.glass-group[data-moving]). */
const SLIDE = 320
/** Tab keys and the direction in which each one looks for an enabled tab. */
const STEPS: Record<string, 1 | -1> = { ArrowRight: 1, Home: 1, ArrowLeft: -1, End: -1 }

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
  /** The selected item stays liquid glass at rest, below its icon and label. */
  glass?: boolean
  className?: string
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * One choice of many, as tabs or buttons. A background holds the whole group,
 * and one indicator slides to the selected item. While it moves or the pointer
 * presses an item, the indicator is liquid glass (see .glass-group in index.css).
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
  glass,
  className
}: GlassGroupProps<T>): React.JSX.Element {
  const tabs = kind === 'tabs'
  const tabId = (item: T): string | undefined => (id ? `${id}-tab-${item}` : undefined)
  const selected = items.findIndex((item) => item.value === value)
  // The one tab in the tab order: the selected tab, or the first enabled tab when
  // the selected tab is disabled or no tab is selected.
  const tabStop =
    selected >= 0 && !items[selected].disabled
      ? selected
      : items.findIndex((item) => !item.disabled)

  // A new selection slides the indicator as glass. The state changes in the same
  // render as the position, so the slide transition applies to the move.
  const [shown, setShown] = useState(selected)
  const [moving, setMoving] = useState(false)
  if (shown !== selected) {
    setShown(selected)
    setMoving(!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  }
  useEffect(() => {
    if (!moving) return
    const timer = setTimeout(() => setMoving(false), SLIDE)
    return () => clearTimeout(timer)
  }, [moving, selected])
  const [pressed, press] = usePress()

  // The item boxes place the indicator and the copy of the items in its lens.
  // The indicator shows only after the first measure, so it does not slide in.
  // A change of the items, the layout props or the group size measures again,
  // because each can move items that keep their size.
  const root = useRef<HTMLDivElement>(null)
  const [boxes, setBoxes] = useState<Box[]>([])
  const order = items.map((item) => item.value).join('\n')
  useLayoutEffect(() => {
    const group = root.current!
    const buttons = Array.from(group.querySelectorAll<HTMLElement>(':scope > button'))
    const measure = (): void => {
      const next = buttons.map((b) => ({
        x: b.offsetLeft,
        y: b.offsetTop,
        w: b.offsetWidth,
        h: b.offsetHeight
      }))
      setBoxes((last) => (JSON.stringify(last) === JSON.stringify(next) ? last : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    for (const element of [group, ...buttons]) observer.observe(element)
    return () => observer.disconnect()
  }, [order, display, size, className])

  const move = (event: React.KeyboardEvent, index: number): void => {
    if (!tabs) return
    const count = items.length
    const step = STEPS[event.key]
    if (!step) return
    event.preventDefault()
    let next =
      event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + step + count) % count
    // Skip disabled items in the direction of travel.
    for (let tries = 1; items[next].disabled && tries < count; tries++) {
      next = (next + step + count) % count
    }
    if (next === index || items[next].disabled) return
    const target = items[next].value
    onValueChange(target)
    const element = tabId(target)
    if (element) document.getElementById(element)?.focus()
  }

  const stacked = display === 'stacked'
  const radius = stacked ? (size === 'sm' ? 'rounded-lg' : 'rounded-[10px]') : 'rounded-md'
  // Each item, and its copy in the lens. The selected text is ink, because the
  // accent is below 4.5:1 contrast in the light and gray themes.
  const itemClass = cn(
    'flex items-center justify-center text-tone-300 data-[selected]:text-ink',
    radius,
    display === 'label' && 'gap-1.5 font-mono font-medium uppercase tracking-[0.1em]',
    display === 'label' && (size === 'sm' ? 'h-6 px-2 text-[10px]' : 'h-7 px-2.5 text-[11px]'),
    display === 'icon' && (size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'),
    stacked && 'flex-col py-1.5 leading-none',
    stacked &&
      (size === 'sm'
        ? 'min-w-[4.5rem] max-w-[7rem] gap-1.5 px-3 text-[11px] font-medium'
        : 'min-w-[76px] gap-1 px-2.5 text-[13px]')
  )
  const iconClass = stacked
    ? size === 'sm'
      ? 'h-5 w-5'
      : 'h-[22px] w-[22px]'
    : size === 'sm'
      ? 'h-3.5 w-3.5'
      : 'h-4 w-4'
  const content = (item: GlassGroupItem<T>): React.JSX.Element => {
    const Icon = item.icon
    return (
      <>
        {Icon && <Icon aria-hidden="true" className={iconClass} strokeWidth={stacked ? 1.75 : 2} />}
        {display !== 'icon' && <span className="max-w-full truncate">{item.label}</span>}
      </>
    )
  }
  const box = boxes[selected]
  return (
    <div
      ref={root}
      role={tabs ? 'tablist' : 'group'}
      aria-label={label}
      data-glass={glass || undefined}
      data-moving={moving || undefined}
      data-pressed={pressed || undefined}
      onPointerDown={(event) => {
        const button = (event.target as Element).closest('button')
        if (button && !button.disabled) press(event)
      }}
      className={cn(
        'glass-group relative inline-flex p-0.5',
        stacked ? (size === 'sm' ? 'rounded-[10px]' : 'rounded-xl') : 'rounded-lg',
        className
      )}
    >
      {box && (
        <span
          aria-hidden="true"
          className={cn('glass-group-indicator', radius, disabled && 'opacity-40')}
          style={
            {
              '--glass-x': `${box.x}px`,
              '--glass-y': `${box.y}px`,
              '--glass-w': `${box.w}px`,
              '--glass-h': `${box.h}px`
            } as React.CSSProperties
          }
        >
          <span className="glass-group-lens">
            {items.map((item, index) => {
              const at = boxes[index]
              return (
                at && (
                  <span
                    key={item.value}
                    data-selected={index === selected || undefined}
                    className={itemClass}
                    style={{ left: at.x, top: at.y, width: at.w, height: at.h }}
                  >
                    {content(item)}
                  </span>
                )
              )
            })}
          </span>
        </span>
      )}
      {items.map((item, index) => {
        const isSelected = index === selected
        return (
          <button
            key={item.value}
            id={tabs ? tabId(item.value) : undefined}
            type="button"
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? isSelected : undefined}
            aria-controls={tabs ? panelId?.(item.value) : undefined}
            aria-pressed={tabs ? undefined : isSelected}
            tabIndex={tabs ? (index === tabStop ? 0 : -1) : undefined}
            aria-label={display === 'icon' ? item.label : undefined}
            title={item.title ?? (display === 'icon' ? item.label : undefined)}
            aria-keyshortcuts={item.keyshortcuts}
            disabled={disabled || item.disabled}
            data-selected={isSelected || undefined}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              itemClass,
              'relative hover:text-tone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/60 disabled:opacity-40'
            )}
          >
            {content(item)}
          </button>
        )
      })}
    </div>
  )
}
