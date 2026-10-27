import type { EditRecipe } from '@shared/editor'
import { insideQuad, pictureQuad, type Point } from './perspective'

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

/**
 * Inverse of cropToFrame; null when the crop would leave the image. A `quad`
 * (the picture outline of a perspective correction, in the same pixels as the
 * unrotated picture) also has to contain the frame.
 */
export function frameToCrop(
  frame: Frame,
  degrees: number,
  w: number,
  h: number,
  quad?: Point[]
): Rect | null {
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
  if (quad) {
    // The picture is turned by `degrees` in the view; turn the corners back.
    const inside = [
      [frame.x, frame.y],
      [frame.x + frame.width, frame.y],
      [frame.x + frame.width, frame.y + frame.height],
      [frame.x, frame.y + frame.height]
    ].every(([px, py]) =>
      insideQuad(quad, {
        x: w / 2 + cos * (px - w / 2) + sin * (py - h / 2),
        y: h / 2 - sin * (px - w / 2) + cos * (py - h / 2)
      })
    )
    if (!inside) return null
  }
  const left = Math.max(0, x)
  const top = Math.max(0, y)
  return { x: left, y: top, width: Math.min(width, 1 - left), height: Math.min(height, 1 - top) }
}

/**
 * Move the frame (`move`) or drag its edges (any of n/s/e/w). A locked
 * `ratio` (width / height) keeps the opposite corner fixed, or the other axis
 * centered for a side handle. `symmetric` keeps the frame center fixed.
 */
export function dragFrame(
  s: Frame,
  handle: string,
  dx: number,
  dy: number,
  ratio?: number,
  symmetric = false
): Frame {
  if (handle === 'move') return { ...s, x: s.x + dx, y: s.y + dy }
  if (symmetric) {
    dx *= 2
    dy *= 2
  }
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
  const width = Math.abs(r - l)
  const height = Math.abs(b - t)
  return {
    x: symmetric ? s.x + (s.width - width) / 2 : Math.min(l, r),
    y: symmetric ? s.y + (s.height - height) / 2 : Math.min(t, b),
    width,
    height
  }
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
  // A new free crop needs both axes to move before it has area.
  if (tx === 0 && crop(0, 0) === null) {
    const t = furthest((t) => crop(dx * t, dy * t) !== null)
    return crop(dx * t, dy * t)
  }
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

/** Snap step of the rotate drag with Shift held, in degrees. */
export const SNAP = 15

/**
 * Straighten angle for a rotate drag: the angle the pointer swept around
 * `center`, added to `start`. Shift snaps to `SNAP` steps. Clamped to the slider range.
 */
export function sweptAngle(
  start: number,
  from: Point,
  to: Point,
  center: Point,
  snap: boolean
): number {
  const at = (p: Point): number => Math.atan2(p.y - center.y, p.x - center.x)
  const swept = ((((at(to) - at(from)) * 180) / Math.PI + 540) % 360) - 180
  const value = snap ? Math.round((start + swept) / SNAP) * SNAP : start + swept
  return Math.max(-45, Math.min(45, value))
}

/** The picture outline of a perspective correction; undefined when there is none. */
const outline = (pitch: number, yaw: number, w: number, h: number): Point[] | undefined =>
  pitch || yaw ? pictureQuad(pitch, yaw, w, h) : undefined

/**
 * The largest frame of `aspect` (width / height) centered on a point, up to
 * `max` wide, that `valid` accepts. Validity must shrink toward the center.
 */
function largestAbout(
  cx: number,
  cy: number,
  aspect: number,
  max: number,
  valid: (frame: Frame) => boolean
): Frame | null {
  const at = (width: number): Frame => ({
    x: cx - width / 2,
    y: cy - width / aspect / 2,
    width,
    height: width / aspect
  })
  if (valid(at(max))) return at(max)
  let lo = max * 1e-3
  if (!valid(at(lo))) return null
  let hi = max
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (valid(at(mid))) lo = mid
    else hi = mid
  }
  return at(lo)
}

/**
 * The crop itself when its frame fits the picture outline at this angle and
 * perspective; otherwise the crop shrunk about its center until it fits.
 */
export function fitCrop(
  crop: Rect,
  degrees: number,
  pitch: number,
  yaw: number,
  w: number,
  h: number
): Rect {
  const quad = outline(pitch, yaw, w, h)
  const frame = cropToFrame(crop, degrees, w, h)
  const to = (f: Frame): Rect | null => frameToCrop(f, degrees, w, h, quad)
  if (to(frame)) return crop
  const aspect = frame.width / frame.height
  const valid = (f: Frame): boolean => to(f) !== null
  const fit =
    largestAbout(
      frame.x + frame.width / 2,
      frame.y + frame.height / 2,
      aspect,
      frame.width,
      valid
    ) ?? largestAbout(w / 2, h / 2, aspect, frame.width, valid)
  return (fit && to(fit)) ?? crop
}

/** The largest crop of frame `aspect` (width / height), centered on the picture. */
export function centeredCrop(
  aspect: number,
  degrees: number,
  pitch: number,
  yaw: number,
  w: number,
  h: number
): Rect | null {
  const quad = outline(pitch, yaw, w, h)
  const to = (f: Frame): Rect | null => frameToCrop(f, degrees, w, h, quad)
  const fit = largestAbout(w / 2, h / 2, aspect, Math.max(w, h * aspect), (f) => to(f) !== null)
  return fit && to(fit)
}
