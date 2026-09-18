import { TriangleAlert } from 'lucide-react'
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
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-300">{label}</span>
      {children}
    </div>
  )
}

export function ToggleRow({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <Row label={label}>
      <Switch checked={checked} onCheckedChange={onChange} />
    </Row>
  )
}

export function Divider(): React.JSX.Element {
  return <div className="h-px bg-white/10" />
}

export function Callout({ text }: { text: string }): React.JSX.Element {
  return (
    <div className={cn('flex items-start gap-2 rounded-md bg-white/5 px-3 py-2')}>
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/80" />
      <span className="text-xs text-neutral-400">{text}</span>
    </div>
  )
}
