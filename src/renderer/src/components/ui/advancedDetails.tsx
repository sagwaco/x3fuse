import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useStoredOpen } from '../../hooks/useStoredOpen'
import { animateDetails } from '../../lib/animateDetails'

/**
 * A collapsible group in a rounded container. With an id, it keeps its open state
 * (open at first) and its header stays below the section header while it scrolls.
 * Without an id, it starts closed.
 */
export function AdvancedDetails({
  id,
  name,
  info,
  action,
  children
}: {
  id?: string
  name: string
  /** An icon button after the name, such as an info popover. */
  info?: React.ReactNode
  /** An icon button at the right end of the header, such as a reset. */
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useStoredOpen(id)
  // A click on a control in the summary would toggle the group.
  const control = (node: React.ReactNode, className?: string): React.ReactNode =>
    node && (
      <span
        className={cn('flex items-center', className)}
        onClick={(event) => event.preventDefault()}
      >
        {node}
      </span>
    )
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-xl border border-ink/10 bg-ink/[0.02] text-xs text-tone-300"
    >
      <summary
        onClick={animateDetails}
        className={cn(
          'control-label flex cursor-pointer list-none select-none items-center gap-1.5 rounded-xl px-3 py-2.5 font-bold text-tone-400 [&::-webkit-details-marker]:hidden',
          id &&
            'sticky top-10 z-[1] bg-[color:color-mix(in_srgb,rgb(var(--ink))_2%,color-mix(in_srgb,rgb(var(--tone-900))_30%,rgb(var(--tone-950))))]'
        )}
      >
        {name}
        {control(info)}
        {control(action, 'ml-auto')}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-tone-500 transition-transform [details[open]:not([data-closing])>summary>&]:rotate-180',
            !action && 'ml-auto'
          )}
        />
      </summary>
      <div className="space-y-3 px-3 pb-3 pt-1">{children}</div>
    </details>
  )
}
