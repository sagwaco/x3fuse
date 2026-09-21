import type { X3FFileDTO } from '@shared/types'
import { OrientedImage } from './OrientedImage'

/**
 * Fixed-box embedded preview for the grid and filmstrip cells. Thin wrapper over
 * {@link OrientedImage} (which handles EXIF orientation, lazy loading, and the
 * loading/error states); `className` styles the box.
 */
export function Thumbnail({
  file,
  className,
  maxEdge
}: {
  file: X3FFileDTO
  className?: string
  maxEdge?: number
}): React.JSX.Element {
  return <OrientedImage file={file} containerClassName={className} maxEdge={maxEdge} />
}
