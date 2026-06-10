/**
 * EXIF-orientation handling for the embedded preview JPEGs. The Foveon sensor is
 * landscape-native and the previews carry no orientation tag of their own, so we
 * read the X3F's Orientation (1–8) and bake the rotation/flip into a canvas at
 * the correct dimensions — which keeps all CSS layout (object-contain, fit) honest
 * without per-container transform math. The same canvas pass crops the
 * aspect-ratio letterbox bars (see aspectCrop) when a target aspect is given.
 */
import { cropRect } from './aspectCrop'
import type { PreviewVariant } from './previewUrl'

export interface DrawOptions {
  /** Cap the longest displayed edge (keeps rotated full-res previews to a sane size). */
  maxEdge?: number
  /** Intended aspect ratio (stored w/h); crops the letterbox bars when set. */
  aspectRatio?: number
}

/** True when the orientation requires any rotation/flip (i.e. not absent/normal). */
export function needsOrientation(orientation: number | undefined): boolean {
  return orientation != null && orientation >= 2 && orientation <= 8
}

/** The small embedded preview is a fixed 4:3 (640×480) frame. */
const PREVIEW_FRAME_AR = 4 / 3

/**
 * Whether a variant must be drawn through this orientation/crop canvas.
 *
 * Only the small `preview` JPEG (PreviewImage) needs it: it carries no EXIF
 * orientation of its own (so we rotate it manually) and letterboxes non-4:3
 * crops with black bars (so we crop them). The full-res `full` JPEG (JpgFromRaw)
 * is self-describing — it embeds its own EXIF Orientation and is already cropped
 * to its final aspect ratio — so it renders as a plain `<img>` that the browser
 * orients, and must NEVER go through the canvas (doing so double-rotates it).
 */
export function shouldUseCanvas(
  variant: PreviewVariant,
  orientation: number | undefined,
  aspectRatio: number | undefined
): boolean {
  if (variant !== 'preview') return false
  const needsCrop = aspectRatio != null && Math.abs(aspectRatio - PREVIEW_FRAME_AR) > 0.02
  return needsOrientation(orientation) || needsCrop
}

/** Orientations 5–8 swap width/height (90°/270° rotations). */
function swapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8
}

/**
 * Draw `bitmap` into `canvas` applying the EXIF `orientation` (and, when
 * `opts.aspectRatio` is given, cropping the letterbox bars), downscaling so the
 * longest edge is at most `opts.maxEdge`. The canvas is sized to the *displayed*
 * (cropped, oriented) dimensions.
 */
export function drawImageWithOrientation(
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
  orientation: number,
  opts: DrawOptions = {}
): void {
  const { maxEdge = 1800, aspectRatio } = opts

  // Source rectangle (the content, with letterbox bars excluded).
  const crop = aspectRatio
    ? cropRect(bitmap.width, bitmap.height, aspectRatio)
    : { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height }

  // Displayed (pre-rotation) size after the maxEdge downscale.
  const scale = Math.min(1, maxEdge / Math.max(crop.sw, crop.sh))
  const w = Math.max(1, Math.round(crop.sw * scale))
  const h = Math.max(1, Math.round(crop.sh * scale))

  canvas.width = swapsAxes(orientation) ? h : w
  canvas.height = swapsAxes(orientation) ? w : h

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // Canonical EXIF-orientation transform matrices (origin pre-rotation is w×h).
  switch (orientation) {
    case 2:
      ctx.setTransform(-1, 0, 0, 1, w, 0)
      break
    case 3:
      ctx.setTransform(-1, 0, 0, -1, w, h)
      break
    case 4:
      ctx.setTransform(1, 0, 0, -1, 0, h)
      break
    case 5:
      ctx.setTransform(0, 1, 1, 0, 0, 0)
      break
    case 6:
      ctx.setTransform(0, 1, -1, 0, h, 0)
      break
    case 7:
      ctx.setTransform(0, -1, -1, 0, h, w)
      break
    case 8:
      ctx.setTransform(0, -1, 1, 0, 0, w)
      break
    default:
      ctx.setTransform(1, 0, 0, 1, 0, 0)
  }
  ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h)
}
