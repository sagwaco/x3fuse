import { Layers } from 'lucide-react'
import type { X3FFileDTO } from '@shared/types'
import { cn } from '../lib/cn'
import { t } from '../lib/strings'

/** Marks an X3I (Super Fine Detail) photo, a stack of frames that the editor merges. */
export function StackBadge({
  file,
  overlay = false
}: {
  file: X3FFileDTO
  overlay?: boolean
}): React.JSX.Element | null {
  if (!file.frames) return null
  const label = t('editor.x3iFrames', { frames: file.frames })
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 leading-none tabular-nums',
        overlay
          ? 'absolute right-1 top-1 rounded bg-tone-950/80 p-1 text-[12px] font-medium text-tone-100'
          : 'text-[12px] text-tone-400'
      )}
    >
      <Layers aria-hidden="true" className="h-3 w-3" />
      {file.frames}
    </span>
  )
}
