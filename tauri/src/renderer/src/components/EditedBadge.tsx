import { Pencil } from 'lucide-react'
import type { EditRecord } from '@shared/editor'
import { cn } from '../lib/cn'
import { t } from '../lib/strings'

export function EditedBadge({
  edit,
  overlay = false
}: {
  edit?: EditRecord
  overlay?: boolean
}): React.JSX.Element | null {
  // Export previews can carry an untouched default recipe at revision zero.
  if (!edit || edit.revision === 0) return null
  const label = t('editor.edited')
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        overlay
          ? 'absolute bottom-1 right-1 rounded bg-neutral-950/80 p-1 text-neutral-100'
          : 'text-neutral-400'
      )}
    >
      <Pencil aria-hidden="true" className="h-3 w-3" />
    </span>
  )
}
