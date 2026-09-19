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
    <div className="border-b border-white/10 px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </div>
  )
}
