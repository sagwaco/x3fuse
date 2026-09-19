import type { X3FFileDTO } from '@shared/types'
import type { PreviewVariant } from '@shared/preview'
import { OrientedImage } from './OrientedImage'

/**
 * Fixed-box embedded preview for the grid and filmstrip cells. Thin wrapper over
 * {@link OrientedImage} (which handles EXIF orientation, lazy loading, and the
 * loading/error states); `className` styles the box.
 */
export function Thumbnail({
  file,
  variant = 'preview',
  className
}: {
  file: X3FFileDTO
  variant?: PreviewVariant
  className?: string
}): React.JSX.Element {
  return <OrientedImage file={file} variant={variant} containerClassName={className} />
}
