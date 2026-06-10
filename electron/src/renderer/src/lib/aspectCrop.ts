/**
 * Sigma cameras fit a non-4:3 aspect-ratio crop inside the fixed 640×480 preview
 * frame, centered, with black letterbox/pillarbox bars filling the rest. Given
 * the source dimensions and the intended aspect ratio, this returns the centered
 * sub-rectangle of the content (the bars excluded) so the UI can crop them out.
 *
 * The full-resolution JpgFromRaw is already cropped to the aspect ratio, so for
 * that source `sourceAR === targetAspect` and this is a no-op — the same formula
 * works for both preview sizes.
 */
export interface CropRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/** Tolerance (1% of the aspect) within which no crop is applied. */
const EPS = 0.01

export function cropRect(sourceW: number, sourceH: number, targetAspect: number): CropRect {
  const full: CropRect = { sx: 0, sy: 0, sw: sourceW, sh: sourceH }
  if (!(targetAspect > 0) || !(sourceW > 0) || !(sourceH > 0)) return full

  const sourceAR = sourceW / sourceH
  if (Math.abs(sourceAR - targetAspect) / targetAspect < EPS) return full

  if (targetAspect > sourceAR) {
    // Content is wider than the frame -> bars top & bottom; crop the height.
    const sh = sourceW / targetAspect
    return { sx: 0, sy: (sourceH - sh) / 2, sw: sourceW, sh }
  }
  // Content is taller than the frame -> bars left & right; crop the width.
  const sw = sourceH * targetAspect
  return { sx: (sourceW - sw) / 2, sy: 0, sw, sh: sourceH }
}
