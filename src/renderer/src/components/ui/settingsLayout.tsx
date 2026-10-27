import { useContext, useId } from 'react'
import { HelpOnHover } from './helpOnHover'
import { Tooltip } from './tooltip'
import { cn } from '../../lib/cn'
import { t } from '../../lib/strings'
import { Info, TriangleAlert } from 'lucide-react'
import { Switch } from './switch'

/**
 * Shared layout primitives for settings forms, used by both the Settings window
 * and the Export screen's settings sidebar so the two surfaces stay in sync.
 */

/** The text of a field label. It has less contrast than the value. */
export const FIELD_LABEL = 'font-sans text-[12px] font-medium text-tone-400'

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
  const hoverHelp = useContext(HelpOnHover) && !!help
  const name = <span className={FIELD_LABEL}>{label}</span>
  return (
    <div className="flex items-center justify-between gap-3">
      {hoverHelp ? (
        <HelpTooltip label={label} text={help!}>
          {name}
        </HelpTooltip>
      ) : (
        name
      )}
      <div className="flex shrink-0 items-center gap-2">
        {warning && <HelpTooltip label={label} text={warning} warning />}
        {help && !hoverHelp && <HelpTooltip label={label} text={help} />}
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
  warning = false,
  children
}: {
  label: string
  text: string
  className?: string
  warning?: boolean
  /**
   * The field label. With a label, the help shows on label hover too, and the
   * icon shows only on label hover or focus.
   */
  children?: React.ReactNode
}): React.JSX.Element {
  const Icon = warning ? TriangleAlert : Info
  const id = useId()
  const button = (
    <button
      type="button"
      aria-label={warning ? t('settings.warning_label', { setting: label }) : label}
      // The tooltip opens on the label, so the button keeps its own description.
      aria-describedby={children ? id : undefined}
      // The icon only shows help, so it keeps the default pointer.
      className={cn(
        'cursor-default rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50',
        warning
          ? 'text-yellow-400 [[data-theme=light]_&]:text-yellow-700 [[data-theme=gray]_&]:text-yellow-950'
          : 'text-tone-400 hover:text-tone-100',
        children &&
          'opacity-0 transition-opacity group-hover/help:opacity-100 group-focus-within/help:opacity-100',
        className
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  )
  return (
    <Tooltip
      text={text}
      side="top"
      className="export-help-tooltip max-w-[min(18rem,var(--radix-tooltip-content-available-width))]"
    >
      {children ? (
        <span className="group/help flex min-w-0 items-center gap-1.5">
          {children}
          {button}
          <span id={id} hidden>
            {text}
          </span>
        </span>
      ) : (
        button
      )}
    </Tooltip>
  )
}
