export function PanelSection({
  title,
  action,
  children
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-b border-ink/10 px-3 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="control-label text-[10px] tracking-[0.16em] text-tone-500">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}
