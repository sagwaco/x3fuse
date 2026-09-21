import { Tooltip } from './tooltip'
import { Info } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Switch } from './switch'

/**
 * Shared layout primitives for settings forms, used by both the Settings window
 * and the Export screen's settings sidebar so the two surfaces stay in sync.
 */

export function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
      <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-4">
        {children}
      </div>
    </section>
  )
}

export function Row({
  label,
  children,
  labelClassName,
  help
}: {
  label: string
  children: React.ReactNode
  labelClassName?: string
  help?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={cn('text-sm text-neutral-300', labelClassName)}>{label}</span>
      <div className="flex shrink-0 items-center gap-2">
        {help && <HelpTooltip label={label} text={help} />}
        {children}
      </div>
    </div>
  )
}

export function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
  labelClassName,
  help
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  labelClassName?: string
  help?: string
}): React.JSX.Element {
  return (
    <Row label={label} labelClassName={labelClassName} help={help}>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </Row>
  )
}

export function Divider(): React.JSX.Element {
  return <div className="h-px bg-white/10" />
}

function HelpTooltip({ label, text }: { label: string; text: string }): React.JSX.Element {
  return (
    <Tooltip
      text={text}
      side="left"
      className="export-help-tooltip max-w-[min(18rem,var(--radix-tooltip-content-available-width))]"
    >
      <button
        type="button"
        aria-label={label}
        className="rounded text-neutral-400 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Tooltip>
  )
}
