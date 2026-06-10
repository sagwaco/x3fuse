import { Loader2 } from 'lucide-react'
import type { X3FFileDTO } from '@shared/types'
import { statusTooltip, statusVisual } from '../lib/fileStatus'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'

/** Port of StatusIconView: a spinner while processing, else a colored status glyph. */
export function StatusIcon({ file }: { file: X3FFileDTO }): React.JSX.Element {
  // Still importing (metadata not yet read): a neutral spinner, distinct from the
  // blue conversion spinner below.
  if (file.pending) {
    return (
      <span
        className="inline-flex h-4 w-4 items-center justify-center"
        title={t('status.importing')}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />
      </span>
    )
  }

  const tooltip = statusTooltip(file)

  if (file.status === 'processing') {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center" title={tooltip}>
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
      </span>
    )
  }

  const { icon: Icon, color } = statusVisual(file.status)
  return (
    <span className="inline-flex h-4 w-4 items-center justify-center" title={tooltip}>
      <Icon className={cn('h-3.5 w-3.5', color)} />
    </span>
  )
}
