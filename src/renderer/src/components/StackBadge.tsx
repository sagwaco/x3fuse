import type { X3FFileDTO } from '@shared/types'
import { cn } from '../lib/cn'
import { t } from '../lib/strings'
import { CutoutTag } from './ui/cutoutTag'

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
    <CutoutTag
      label={label}
      className={cn(
        'font-mono text-[12px] font-bold text-tone-100 opacity-60 group-data-[selected]:opacity-100',
        overlay && 'absolute right-1 top-1 transition-opacity group-hover:opacity-0'
      )}
      style={{ width: 'calc(3ch + 0.5rem)' }}
    >
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="black">
        X3I
      </text>
    </CutoutTag>
  )
}
