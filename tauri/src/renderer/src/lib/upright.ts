/**
 * Level and Upright analysis for the crop view.
 *
 * Both find long straight edges in the crop view's picture (the corrected
 * image, not straightened, not rotated). `level` only uses the 2D tilt of the
 * lines. `upright` turns the lines into camera rays with `perspective.ts`, finds
 * the vertical and horizontal vanishing directions, and returns the camera turn
 * that makes them vertical and horizontal.
 */
import {
  apply,
  cameraTurn,
  decompose,
  insideQuad,
  pictureQuad,
  rotationX,
  rotationY,
  sourceRay
} from './perspective'
import type { Mat3, Point } from './perspective'

/** Pixels of the crop view's picture: the corrected image, unstraightened, unrotated. */
export interface Picture {
  data: Uint8ClampedArray // RGBA, like ImageData
  width: number
  height: number
}

type Vec = number[]
/** A detected line in picture pixels. */
interface Line {
  x1: number
  y1: number
  x2: number
  y2: number
  length: number
  vertical: boolean
  coverage: number // Share of the line length that has edge points, 0 to 1.
}

const RAD = Math.PI / 180
const MAX_SIDE = 800 // Detection works on a copy reduced to this long side.
const EDGE_MIN = 6 // Smallest gradient (sqrt-scaled gray levels per pixel) that counts as an edge.
const BINS = 720 // Hough angle bins over 180 degrees, 0.25 degrees each.
const BIN = Math.PI / BINS
const VOTE_SPREAD = 16 // A point votes for angles within 16 bins (4 degrees) of its gradient.
const MIN_LINE = 0.12 // Shortest line, as a fraction of the long side.
const MAX_ROUNDS = 80
const OUTLINE_MARGIN = 4 // Pixels (of the reduced copy) kept clear of the picture outline.
const MAX_YAW = 16 // Largest yaw Upright takes from horizontal lines, degrees.
const MAX_ANGLE = 25 // Pitch and yaw limit for Upright, degrees.
const MAX_DENSITY = 0.2 // Most edge points, as a share of the pixels, that still allows lines.
const MIN_COVERAGE = 0.9 // Least share of a trusted line that has edge points.
const MIN_TRUSTED = 0.2 // Shortest trusted line, as a fraction of the long side.
const STRICT = 32 // Perspective only uses lines this close to an axis, degrees.

const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
]
const unit = (a: Vec): Vec => {
  const n = Math.hypot(a[0], a[1], a[2])
  return n > 0 ? a.map((v) => v / n) : a
}
const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v))
const degrees = (radians: number): number => radians / RAD

/**
 * Find long straight edges in the picture. `outline` is the picture outline in
 * picture pixels: the renderer repeats the edge pixels outside it, so gradients
 * outside it, or within a few pixels of it, are ignored.
 */
function detectLines(pic: Picture, outline: Point[]): Line[] {
  const f = Math.max(1, Math.ceil(Math.max(pic.width, pic.height) / MAX_SIDE))
  const w = Math.floor(pic.width / f)
  const h = Math.floor(pic.height / f)
  if (w < 16 || h < 16) return []

  const gray = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let j = 0; j < f; j++) {
        for (let i = 0; i < f; i++) {
          const k = ((y * f + j) * pic.width + x * f + i) * 4
          sum += 0.299 * pic.data[k] + 0.587 * pic.data[k + 1] + 0.114 * pic.data[k + 2]
        }
      }
      // Square root scaling keeps edges in dark parts of the photo visible.
      gray[y * w + x] = 16 * Math.sqrt(sum / (f * f))
    }
  }
  const inner = outline.map((p) => ({ x: p.x / f, y: p.y / f }))

  // Sobel gradients, scaled to gray levels per pixel.
  const gx = new Float32Array(w * h)
  const gy = new Float32Array(w * h)
  const mag = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const a = gray[i - w - 1]
      const b = gray[i - w]
      const c = gray[i - w + 1]
      const d = gray[i - 1]
      const e = gray[i + 1]
      const g = gray[i + w - 1]
      const m = gray[i + w]
      const n = gray[i + w + 1]
      gx[i] = (c + 2 * e + n - a - 2 * d - g) / 8
      gy[i] = (g + 2 * m + n - a - 2 * b - c) / 8
      mag[i] = Math.hypot(gx[i], gy[i])
    }
  }

  // Edge points: thinned along the gradient, inside the outline.
  const px: number[] = []
  const py: number[] = []
  const ux: number[] = []
  const uy: number[] = []
  const center: number[] = []
  for (let y = 3; y < h - 3; y++) {
    for (let x = 3; x < w - 3; x++) {
      const i = y * w + x
      const m = mag[i]
      if (m < EDGE_MIN) continue
      const [before, after] = Math.abs(gx[i]) >= Math.abs(gy[i]) ? [i - 1, i + 1] : [i - w, i + w]
      if (m < mag[before] || m <= mag[after]) continue
      // A negative tolerance asks for this distance (pixels) inside the outline.
      if (!insideQuad(inner, { x, y }, -OUTLINE_MARGIN)) continue
      let angle = Math.atan2(gy[i], gx[i])
      if (angle < 0) angle += Math.PI
      px.push(x)
      py.push(y)
      ux.push(gx[i] / m)
      uy.push(gy[i] / m)
      center.push(Math.round(angle / BIN) % BINS)
    }
  }

  const count = px.length
  // Edges everywhere (noise or fine texture): any line would be chance.
  if (count > MAX_DENSITY * w * h) return []
  const alive = new Uint8Array(count).fill(1)
  const cosT = Array.from({ length: BINS }, (_, b) => Math.cos(b * BIN))
  const sinT = Array.from({ length: BINS }, (_, b) => Math.sin(b * BIN))
  const r0 = w + h
  const rw = 2 * r0 + 1
  const acc = new Int32Array(BINS * rw)
  const vote = (i: number, delta: number): void => {
    for (let k = -VOTE_SPREAD; k <= VOTE_SPREAD; k++) {
      const b = (center[i] + k + BINS) % BINS
      acc[b * rw + Math.round(px[i] * cosT[b] + py[i] * sinT[b]) + r0] += delta
    }
  }
  for (let i = 0; i < count; i++) vote(i, 1)

  const minLength = MIN_LINE * Math.max(w, h)
  const lines: Line[] = []
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let best = 0
    let at = -1
    for (let b = 0; b < BINS; b++) {
      const base = b * rw
      for (let r = 1; r < rw - 1; r++) {
        const s = acc[base + r - 1] + acc[base + r] + acc[base + r + 1]
        if (s > best) {
          best = s
          at = base + r
        }
      }
    }
    if (best < minLength * 0.8) break
    const bin = Math.floor(at / rw)
    let nx = cosT[bin]
    let ny = sinT[bin]
    let rho = (at % rw) - r0
    let cx = 0
    let cy = 0
    let inliers: number[] = []
    // The two edges of a thin bright or dark line face opposite ways. Take one polarity
    // only, or the fits of the two edges pull each other and turn the line.
    let side = 0
    for (let pass = 0; pass < 4; pass++) {
      const tolerance = pass === 0 ? 2.5 : 1.5
      if (pass === 0) {
        let sum = 0
        for (let i = 0; i < count; i++) {
          if (alive[i] && Math.abs(px[i] * nx + py[i] * ny - rho) <= tolerance)
            sum += ux[i] * nx + uy[i] * ny
        }
        side = sum < 0 ? -1 : 1
      }
      inliers = []
      for (let i = 0; i < count; i++) {
        if (!alive[i]) continue
        const distance = Math.abs(px[i] * nx + py[i] * ny - rho)
        const facing = ux[i] * nx + uy[i] * ny
        // Soft edges flip polarity from noise, so the other polarity counts right on the line.
        if (
          (distance <= tolerance && side * facing >= 0.9) ||
          (distance <= 0.8 && Math.abs(facing) >= 0.9)
        ) {
          inliers.push(i)
        }
      }
      if (inliers.length < 2) break
      // Least squares fit: the line runs along the main axis of the inliers.
      cx = cy = 0
      for (const i of inliers) {
        cx += px[i]
        cy += py[i]
      }
      cx /= inliers.length
      cy /= inliers.length
      let sxx = 0
      let sxy = 0
      let syy = 0
      for (const i of inliers) {
        sxx += (px[i] - cx) ** 2
        sxy += (px[i] - cx) * (py[i] - cy)
        syy += (py[i] - cy) ** 2
      }
      const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
      const flip = -Math.sin(theta) * nx + Math.cos(theta) * ny < 0 ? -1 : 1
      nx = -Math.sin(theta) * flip
      ny = Math.cos(theta) * flip
      rho = cx * nx + cy * ny
    }

    let accepted: Line | null = null
    if (inliers.length >= minLength * 0.8) {
      const dx = ny
      const dy = -nx
      let lo = Infinity
      let hi = -Infinity
      for (const i of inliers) {
        const t = (px[i] - cx) * dx + (py[i] - cy) * dy
        lo = Math.min(lo, t)
        hi = Math.max(hi, t)
      }
      const tilt = degrees(Math.atan2(Math.abs(dy), Math.abs(dx)))
      const cells = new Set<number>()
      for (const i of inliers)
        cells.add(Math.floor(((px[i] - cx) * dx + (py[i] - cy) * dy - lo) / 6))
      const coverage = cells.size / (Math.floor((hi - lo) / 6) + 1)
      if (hi - lo >= minLength) {
        accepted = {
          x1: (cx + lo * dx + 0.5) * f,
          y1: (cy + lo * dy + 0.5) * f,
          x2: (cx + hi * dx + 0.5) * f,
          y2: (cy + hi * dy + 0.5) * f,
          length: (hi - lo) * f,
          vertical: tilt >= 45,
          coverage
        }
      }
    }
    if (accepted) lines.push(accepted)
    if (inliers.length) {
      for (const i of inliers) {
        alive[i] = 0
        vote(i, -1)
      }
    } else {
      acc[at] = 0
    }
  }
  return lines
}

/** Lines that are long, straight and unbroken: the only ones worth trusting. */
function reliable(lines: Line[], long: number): Line[] {
  return lines.filter((l) => l.coverage >= MIN_COVERAGE && l.length >= MIN_TRUSTED * long)
}

/**
 * The straighten angle that levels the picture, or null when no line stands out.
 * Long lines count much more than short ones, so a horizon beats clutter.
 */
function levelOf(lines: Line[], long: number): number | null {
  // Tilt is the clockwise turn on screen (y down), in degrees.
  const tilts = reliable(lines, long).map((l) => {
    let dx = l.x2 - l.x1
    let dy = l.y2 - l.y1
    if (l.vertical ? dy < 0 : dx < 0) {
      dx = -dx
      dy = -dy
    }
    const value = degrees(l.vertical ? Math.atan2(-dx, dy) : Math.atan2(dy, dx))
    // Photos are mostly taken nearly level, and unbroken lines are more likely real edges.
    const likely = l.coverage ** 4 * Math.exp(-((value / 6) ** 2))
    return { value, length: l.length, likely }
  })
  if (!tilts.length) return null
  const near = (center: number, width: number): typeof tilts =>
    tilts.filter((t) => Math.abs(t.value - center) <= width)
  const support = (center: number): number =>
    near(center, 1).reduce((sum, t) => sum + t.length ** 2 * t.likely, 0)
  // The tilt most long lines agree on.
  const best = tilts.reduce((a, b) => (support(b.value) > support(a.value) ? b : a))
  const agreeing = near(best.value, 1)
  const total = tilts.reduce((sum, t) => sum + t.length ** 2 * t.likely, 0)
  const longest = Math.max(...agreeing.map((t) => t.length))
  // It must clearly beat every other direction, not only add up to a share.
  const rival = Math.max(
    0,
    ...tilts.filter((t) => Math.abs(t.value - best.value) > 2.5).map((t) => support(t.value))
  )
  if (
    longest < 0.5 * long ||
    support(best.value) < 0.3 * total ||
    support(best.value) < 1.5 * rival
  ) {
    return null
  }
  // Refine with the longest lines only; the weights favor precise, long lines.
  const fine = near(agreeing.reduce((a, b) => (b.length > a.length ? b : a)).value, 0.75)
  const weight = fine.reduce((sum, t) => sum + t.length ** 3 * t.likely, 0)
  const tilt = fine.reduce((sum, t) => sum + t.value * t.length ** 3 * t.likely, 0) / weight
  return clamp(0 - tilt, -45, 45)
}

/** The picture outline (see `detect`) for the angles the picture was rendered with. */
function outlineOf(
  picture: Picture,
  current: { pitch: number; yaw: number },
  sourceWidth: number,
  sourceHeight: number
): Point[] {
  return pictureQuad(current.pitch, current.yaw, sourceWidth, sourceHeight).map((p) => ({
    x: (p.x * picture.width) / sourceWidth,
    y: (p.y * picture.height) / sourceHeight
  }))
}

/**
 * Level: the straighten angle (degrees, [-45, 45]) that levels the picture, or null if unsure.
 * `current` and the source size describe how the picture was rendered, as for `upright`.
 */
export function level(
  picture: Picture,
  current: { pitch: number; yaw: number },
  sourceWidth: number,
  sourceHeight: number
): number | null {
  const outline = outlineOf(picture, current, sourceWidth, sourceHeight)
  return levelOf(detectLines(picture, outline), Math.max(picture.width, picture.height))
}

/** Sum of w * n * n^T over the planes. */
function scatter(
  planes: { n: Vec; w: number }[],
  weight: (p: { n: Vec; w: number }) => number
): Mat3 {
  const m: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  for (const p of planes) {
    const w = weight(p)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += w * p.n[i] * p.n[j]
  }
  return m
}

/** Eigenvector of the smallest eigenvalue of a symmetric PSD matrix, by power iteration. */
function smallest(m: Mat3, start: Vec): Vec {
  const t = m[0][0] + m[1][1] + m[2][2]
  if (t <= 0) return start
  let v = start
  for (let i = 0; i < 200; i++) {
    const mv = apply(m, v)
    v = unit([t * v[0] - mv[0], t * v[1] - mv[1], t * v[2] - mv[2]])
  }
  return v
}

/** Smallest eigenvalue of `m` on the plane perpendicular to the unit vector `d`. */
function secondSmallest(m: Mat3, d: Vec): number {
  const e1 = unit(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
  const e2 = cross(d, e1)
  const b11 = dot(e1, apply(m, e1))
  const b22 = dot(e2, apply(m, e2))
  const b12 = dot(e1, apply(m, e2))
  return (b11 + b22) / 2 - Math.hypot((b11 - b22) / 2, b12)
}

/**
 * The common direction of the 3D lines whose camera planes have these normals,
 * or null when the lines are too few, disagree, or sit too close together.
 */
function vanishing(planes: { n: Vec; w: number }[], start: Vec, long: number): Vec | null {
  let d = start
  // Start wide, then tighten: robust to lines that do not belong.
  for (const sigma of [20, 12, 8, 5, 3, 2, 1.5, 1.5]) {
    const s = Math.sin(sigma * RAD)
    const current = d
    d = smallest(
      scatter(planes, (p) => p.w / (1 + (dot(p.n, current) / s) ** 2)),
      d
    )
  }
  const tolerance = Math.sin(2 * RAD)
  const inliers = planes.filter((p) => Math.abs(dot(p.n, d)) < tolerance)
  const total = planes.reduce((sum, p) => sum + p.w, 0)
  const got = inliers.reduce((sum, p) => sum + p.w, 0)
  if (inliers.length < 3 || got < 0.8 * long || got < 0.6 * total) return null
  const m = scatter(inliers, (p) => p.w)
  d = smallest(m, d)
  // The normals must spread by about 5 degrees or more, or one line decides everything.
  return secondSmallest(m, d) / got >= Math.sin(5 * RAD) ** 2 ? d : null
}

/** Horizontals only: keep the pitch, search the yaw whose turn can level the lines. */
function fromHorizontal(
  dh: Vec,
  pitch: number
): { roll: number; pitch: number; yaw: number } | null {
  let best: { roll: number; yaw: number; miss: number } | null = null
  for (let yaw = -MAX_ANGLE; yaw <= MAX_ANGLE; yaw += 0.05) {
    const v = apply(rotationX(pitch), apply(rotationY(yaw), dh))
    const miss = Math.abs(v[2])
    if (!best || miss < best.miss) best = { roll: degrees(Math.atan2(-v[1], v[0])), yaw, miss }
  }
  return best && best.miss < Math.sin(RAD) ? { roll: best.roll, pitch, yaw: best.yaw } : null
}

/** Verticals only: keep the yaw, solve pitch and roll. */
function fromVertical(dv: Vec, yaw: number): { roll: number; pitch: number; yaw: number } {
  const w = apply(rotationY(yaw), dv)
  const pitch = degrees(Math.atan2(-w[2], w[1]))
  const v = apply(rotationX(pitch), w)
  return { roll: degrees(Math.atan2(v[0], v[1])), pitch, yaw }
}

/**
 * Upright: absolute roll/pitch/yaw (degrees) for the source photo, given the picture rendered
 * with the current pitch and yaw. `sourceWidth/Height` are the oriented source size the recipe
 * angles refer to (the picture may be a smaller preview of it; scale points accordingly).
 * Returns null when no reliable lines are found.
 */
export function upright(
  picture: Picture,
  current: { pitch: number; yaw: number },
  sourceWidth: number,
  sourceHeight: number
): { straighten: number; pitch: number; yaw: number } | null {
  const all = detectLines(picture, outlineOf(picture, current, sourceWidth, sourceHeight))
  // Perspective needs lines near an axis; Level also takes the ones up to 45 degrees off.
  const lines = reliable(all, Math.max(picture.width, picture.height)).filter((l) => {
    const a = degrees(Math.atan2(Math.abs(l.y2 - l.y1), Math.abs(l.x2 - l.x1)))
    return Math.min(a, 90 - a) <= STRICT
  })
  const long = Math.max(picture.width, picture.height)
  // No usable perspective: level the picture and keep the other angles.
  const keep = (): { straighten: number; pitch: number; yaw: number } | null => {
    const straighten = levelOf(all, long)
    return straighten === null ? null : { straighten, ...current }
  }

  const sx = sourceWidth / picture.width
  const sy = sourceHeight / picture.height
  const ray = (x: number, y: number): Vec =>
    sourceRay(current.pitch, current.yaw, sourceWidth, sourceHeight, { x: x * sx, y: y * sy })
  const planes = (vertical: boolean): { n: Vec; w: number }[] =>
    lines
      .filter((l) => l.vertical === vertical)
      .map((l) => ({ n: unit(cross(ray(l.x1, l.y1), ray(l.x2, l.y2))), w: l.length }))
  const r0 = cameraTurn(current.pitch, current.yaw)
  const dv = vanishing(planes(true), r0[1], long)
  let dh = vanishing(planes(false), r0[0], long)
  // A horizontal direction must be at right angles to the vertical one.
  if (dv && dh && Math.abs(dot(dv, dh)) > Math.sin(10 * RAD)) dh = null

  const solve = (dh: Vec | null): { roll: number; pitch: number; yaw: number } | null => {
    if (dv && dh) {
      let ex = unit(dh.map((v, i) => v - dot(dh, dv) * dv[i]))
      if (dot(ex, r0[0]) < 0) ex = ex.map((v) => -v)
      return decompose([ex, dv, cross(ex, dv)])
    }
    if (dv) return fromVertical(dv, current.yaw)
    return dh ? fromHorizontal(dh, current.pitch) : null
  }
  let angles = solve(dh)
  // Horizontals that ask for a big yaw are more likely a slanted scene than a crooked camera.
  if (dh && angles && Math.abs(angles.yaw) > MAX_YAW) {
    dh = null
    angles = solve(null)
  }
  if (!angles) return keep()

  // Balance: limit the perspective turn and level again with what is left.
  let { roll } = angles
  const pitch = clamp(angles.pitch, -MAX_ANGLE, MAX_ANGLE)
  const yaw = clamp(angles.yaw, -MAX_ANGLE, MAX_ANGLE)
  if (pitch !== angles.pitch || yaw !== angles.yaw) {
    const turn = cameraTurn(pitch, yaw)
    if (dv) {
      const v = apply(turn, dv)
      roll = degrees(Math.atan2(v[0], v[1]))
    } else if (dh) {
      const v = apply(turn, dh)
      roll = degrees(Math.atan2(-v[1], v[0]))
    }
  }
  const result = { straighten: clamp(roll, -45, 45), pitch, yaw }
  return Object.values(result).every(Number.isFinite) ? result : keep()
}
