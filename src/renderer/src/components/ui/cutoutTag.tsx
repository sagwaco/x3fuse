import { useId } from 'react'
import { cn } from '../../lib/cn'

/**
 * A rounded tag with its contents cut out of it, as in the mix pad labels.
 * Draw the children in black. The tag uses the current text color.
 */
export function CutoutTag({
  label,
  className,
  style,
  children
}: {
  label: string
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}): React.JSX.Element {
  const mask = `cutout${useId().replace(/\W/g, '')}`
  return (
    <svg role="img" aria-label={label} className={cn('h-4 shrink-0', className)} style={style}>
      <title>{label}</title>
      <mask id={mask}>
        <rect width="100%" height="100%" rx="4" fill="white" />
        {children}
      </mask>
      <rect width="100%" height="100%" rx="4" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  )
}
