import { Tooltip } from './tooltip'
import { cn } from '../../lib/cn'
import { t } from '../../lib/strings'
import { Info, TriangleAlert } from 'lucide-react'
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
    <section className="flex flex-col gap-2">
      <h2 className="control-label px-1 tracking-[0.16em] text-tone-500">{title}</h2>
      {/* Each child is one row. Hairline dividers separate the rows. */}
      <div className="flex flex-col divide-y divide-ink/10 rounded-xl border border-ink/10 bg-ink/[0.02] [&>*]:px-3.5 [&>*]:py-2">
        {children}
      </div>
    </section>
  )
}

export function Row({
  label,
  children,
  help,
  warning
}: {
  label: string
  children: React.ReactNode
  help?: string
  warning?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-sans text-[13px] text-tone-300">{label}</span>
      <div className="flex shrink-0 items-center gap-2">
        {warning && <HelpTooltip label={label} text={warning} warning />}
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
  help,
  warning
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  help?: string
  warning?: string
}): React.JSX.Element {
  return (
    <Row label={label} help={help} warning={warning}>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </Row>
  )
}

export function HelpTooltip({
  label,
  text,
  className,
  warning = false
}: {
  label: string
  text: string
  className?: string
  warning?: boolean
}): React.JSX.Element {
  const Icon = warning ? TriangleAlert : Info
  return (
    <Tooltip
      text={text}
      side="top"
      className="export-help-tooltip max-w-[min(18rem,var(--radix-tooltip-content-available-width))]"
    >
      <button
        type="button"
        aria-label={warning ? t('settings.warning_label', { setting: label }) : label}
        // The icon only shows help, so it keeps the default pointer.
        className={cn(
          'cursor-default rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50',
          warning
            ? 'text-yellow-400 [[data-theme=light]_&]:text-yellow-700 [[data-theme=gray]_&]:text-yellow-950'
            : 'text-tone-400 hover:text-tone-100',
          className
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Tooltip>
  )
}
