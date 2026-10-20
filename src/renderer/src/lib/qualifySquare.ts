import type { PreviewRegion } from '@shared/editor'

/**
 * A square of about 2 percent of the long edge around a point, 0 to 1 of the oriented
 * image. The embedded preview has the shape of `aspectRatio` (stored w/h) after `orientation`.
 */
export function qualifySquare(
  x: number,
  y: number,
  aspectRatio = 4 / 3,
  orientation = 1
): PreviewRegion {
  const ratio = orientation >= 5 && orientation <= 8 ? 1 / aspectRatio : aspectRatio
  const side = 0.02
  const width = ratio >= 1 ? side : side / ratio
  const height = ratio >= 1 ? side * ratio : side
  return {
    x: Math.max(0, Math.min(1 - width, x - width / 2)),
    y: Math.max(0, Math.min(1 - height, y - height / 2)),
    width,
    height
  }
}
