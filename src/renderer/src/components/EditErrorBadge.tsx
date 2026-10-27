import { TriangleAlert } from 'lucide-react'
import type { X3FFileDTO } from '@shared/types'
import { cn } from '../lib/cn'

/** Shows why the photo could not open or load its edits, such as an unsupported DNG. */
export function EditErrorBadge({
  file,
  overlay = false
}: {
  file: X3FFileDTO
  overlay?: boolean
}): React.JSX.Element | null {
  if (!file.editError) return null
  return (
    <span
      role="img"
      aria-label={file.editError}
      title={file.editError}
      className={cn(
        'inline-flex shrink-0 text-danger',
        overlay && 'absolute bottom-1 right-1 rounded bg-tone-950/80 p-1'
      )}
    >
      <TriangleAlert aria-hidden="true" className="h-3 w-3" />
    </span>
  )
}
