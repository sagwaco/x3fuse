import type { EditRecipe } from '@shared/editor'

/** Normalized recipe crop in the EXIF-oriented image, before rotation/straighten. */
export type Rect = NonNullable<EditRecipe['crop']>
/**
 * The visible output frame, in preview pixels of a view where the image is
 * drawn rotated by the straighten angle about its center. Straightening is
 * then a rotation of the picture under an upright frame, as in Photos.
 */
export type Frame = Rect

export const FULL: Rect = { x: 0, y: 0, width: 1, height: 1 }
/** Landscape presets; the label flips with the frame's orientation. */
export const PRESETS: Array<[number, number]> = [
  [1, 1],
  [4, 3],
  [3, 2],
  [7, 5],
  [7, 6],
  [16, 9],
  [21, 9],
  [65, 24]
]

const radians = (degrees: number): number => (degrees * Math.PI) / 180

/** The renderer zooms a straightened crop until no empty corners show. */
export function zoom(aspect: number, degrees: number): number {
  const a = radians(degrees)
  return Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)) * Math.max(aspect, 1 / aspect)
}

export function cropToFrame(crop: Rect, degrees: number, w: number, h: number): Frame {
  const cw = crop.width * w
  const ch = crop.height * h
  const z = zoom(cw / ch, degrees)
  const cos = Math.cos(radians(degrees))
  const sin = Math.sin(radians(degrees))
  const dx = (crop.x + crop.width / 2 - 0.5) * w
  const dy = (crop.y + crop.height / 2 - 0.5) * h
  const x = w / 2 + cos * dx - sin * dy
  const y = h / 2 + sin * dx + cos * dy
  return { x: x - cw / z / 2, y: y - ch / z / 2, width: cw / z, height: ch / z }
}

/** Inverse of cropToFrame; null when the crop would leave the image. */
export function frameToCrop(frame: Frame, degrees: number, w: number, h: number): Rect | null {
  const z = zoom(frame.width / frame.height, degrees)
  const cos = Math.cos(radians(degrees))
  const sin = Math.sin(radians(degrees))
  const dx = frame.x + frame.width / 2 - w / 2
  const dy = frame.y + frame.height / 2 - h / 2
  const width = (frame.width * z) / w
  const height = (frame.height * z) / h
  const x = (w / 2 + cos * dx + sin * dy) / w - width / 2
  const y = (h / 2 - sin * dx + cos * dy) / h - height / 2
  const e = 1e-6
  if (!(width > 0 && height > 0) || x < -e || y < -e || x + width > 1 + e || y + height > 1 + e)
    return null
  const left = Math.max(0, x)
  const top = Math.max(0, y)
  return { x: left, y: top, width: Math.min(width, 1 - left), height: Math.min(height, 1 - top) }
}

/**
 * Move the frame (`move`) or drag its edges (any of n/s/e/w). A locked
 * `ratio` (width / height) keeps the opposite corner fixed, or the other axis
 * centered for a side handle.
 */
export function dragFrame(s: Frame, handle: string, dx: number, dy: number, ratio?: number): Frame {
  if (handle === 'move') return { ...s, x: s.x + dx, y: s.y + dy }
  let l = s.x
  let t = s.y
  let r = s.x + s.width
  let b = s.y + s.height
  if (handle.includes('w')) l += dx
  if (handle.includes('e')) r += dx
  if (handle.includes('n')) t += dy
  if (handle.includes('s')) b += dy
  if (ratio) {
    const horizontal = /[ew]/.test(handle)
    const vertical = /[ns]/.test(handle)
    let w = Math.abs(r - l)
    let h = Math.abs(b - t)
    if (horizontal && (!vertical || w / ratio >= h)) h = w / ratio
    else w = h * ratio
    const sx = r >= l ? 1 : -1
    const sy = b >= t ? 1 : -1
    if (!horizontal) [l, r] = [s.x + s.width / 2 - w / 2, s.x + s.width / 2 + w / 2]
    else if (handle.includes('w')) l = r - sx * w
    else r = l + sx * w
    if (!vertical) [t, b] = [s.y + s.height / 2 - h / 2, s.y + s.height / 2 + h / 2]
    else if (handle.includes('n')) t = b - sy * h
    else b = t + sy * h
  }
  return { x: Math.min(l, r), y: Math.min(t, b), width: Math.abs(r - l), height: Math.abs(b - t) }
}

/**
 * Apply as much of a drag as fits, per axis, so the frame slides along the
 * image edge instead of stopping dead. `crop` returns null for invalid drags.
 */
export function fitDrag(crop: (dx: number, dy: number) => Rect | null, dx: number, dy: number) {
  const furthest = (valid: (t: number) => boolean): number => {
    if (valid(1)) return 1
    let lo = 0
    let hi = 1
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (valid(mid)) lo = mid
      else hi = mid
    }
    return lo
  }
  const tx = furthest((t) => crop(dx * t, 0) !== null)
  const ty = furthest((t) => crop(dx * tx, dy * t) !== null)
  return crop(dx * tx, dy * ty)
}

/** Largest centered crop whose output has `ratio`, after a quarter `rotation`. */
export function ratioCrop(ratio: number, rotation: number, w: number, h: number): Rect {
  const target = (rotation % 2 ? 1 / ratio : ratio) / (w / h)
  const width = Math.min(1, target)
  const height = Math.min(1, 1 / target)
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height }
}

/** Output width / height of a crop. */
export function outputRatio(crop: Rect, rotation: number, w: number, h: number): number {
  const ratio = (crop.width * w) / (crop.height * h)
  return rotation % 2 ? 1 / ratio : ratio
}

/** The aspect option a crop already matches: 'asShot', a preset like '3:2', or 'free'. */
export function matchAspect(
  crop: Rect,
  asShot: Rect,
  rotation: number,
  w: number,
  h: number
): string {
  const same = (Object.keys(crop) as Array<keyof Rect>).every(
    (key) => Math.abs(crop[key] - asShot[key]) < 0.00001
  )
  if (same) return 'asShot'
  const ratio = outputRatio(crop, rotation, w, h)
  const long = Math.max(ratio, 1 / ratio)
  const preset = PRESETS.find(([a, b]) => Math.abs(long / (a / b) - 1) < 0.001)
  return preset ? preset.join(':') : 'free'
}
