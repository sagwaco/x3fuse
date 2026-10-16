import { Flag, FlagOff } from 'lucide-react'
import type { X3FFileDTO } from '@shared/types'
import { cn } from '../lib/cn'
import { t } from '../lib/strings'

/** A photo's flag and star rating. Shows nothing for an unflagged, unrated photo. */
export function CullBadge({
  file,
  overlay = false
}: {
  file: X3FFileDTO
  overlay?: boolean
}): React.JSX.Element | null {
  const flag = file.flag ?? 'unflagged'
  const rating = file.rating ?? 0
  if (flag === 'unflagged' && !rating) return null
  const label = [
    flag !== 'unflagged' && t(`cull.${flag}`),
    rating > 0 && t('cull.rating', { stars: rating })
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 leading-none',
        // Five stars and a flag fit in a 76 px filmstrip cell.
        overlay
          ? 'absolute bottom-1 left-1 rounded bg-tone-950/80 p-1 text-[9px] text-tone-100'
          : 'text-[11px] text-tone-300'
      )}
    >
      {flag === 'pick' && <Flag aria-hidden="true" className="h-3 w-3 fill-current" />}
      {flag === 'reject' && <FlagOff aria-hidden="true" className="h-3 w-3" />}
      {rating > 0 && (
        <span aria-hidden="true" className="tracking-[-0.05em]">
          {'★'.repeat(rating)}
        </span>
      )}
    </span>
  )
}
