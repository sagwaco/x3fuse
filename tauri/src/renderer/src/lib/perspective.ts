/**
 * Perspective correction as a virtual camera turn, shared with the renderer
 * (x3f-render `geometry.rs`). Keep the two implementations identical.
 *
 * Coordinates are pixels of the EXIF-oriented image, w x h, y down. Rays use
 * centered coordinates divided by the long edge L, with the focal length
 * equal to L: ray = ((x - w/2) / L, (y - h/2) / L, 1).
 *
 * The corrected image is the source seen by a camera turned by
 * R = Rx(pitch) * Ry(yaw), shifted so the image center stays in place and
 * kept at the same scale. Roll is the recipe's straighten angle, applied
 * later about the crop center: R_total = Rz(straighten) * Rx(pitch) * Ry(yaw).
 */
export type Mat3 = [number[], number[], number[]]
export type Point = { x: number; y: number }

const radians = (degrees: number): number => (degrees * Math.PI) / 180
const degrees = (radians: number): number => (radians * 180) / Math.PI

export function multiply(a: Mat3, b: Mat3): Mat3 {
  return [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])
  ) as Mat3
}
export function transpose(m: Mat3): Mat3 {
  return [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]]) as Mat3
}
export function apply(m: Mat3, v: number[]): number[] {
  return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
}

export function rotationX(deg: number): Mat3 {
  const c = Math.cos(radians(deg))
  const s = Math.sin(radians(deg))
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c]
  ]
}
export function rotationY(deg: number): Mat3 {
  const c = Math.cos(radians(deg))
  const s = Math.sin(radians(deg))
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c]
  ]
}
export function rotationZ(deg: number): Mat3 {
  const c = Math.cos(radians(deg))
  const s = Math.sin(radians(deg))
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1]
  ]
}

/** The camera turn the recipe's pitch and yaw describe. */
export function cameraTurn(pitch: number, yaw: number): Mat3 {
  return multiply(rotationX(pitch), rotationY(yaw))
}

/** Split R = Rz(roll) * Rx(pitch) * Ry(yaw) into degrees. */
export function decompose(r: Mat3): { roll: number; pitch: number; yaw: number } {
  const pitch = Math.asin(Math.max(-1, Math.min(1, r[2][1])))
  const yaw = Math.atan2(-r[2][0], r[2][2])
  const z = multiply(r, transpose(cameraTurn(degrees(pitch), degrees(yaw))))
  return { roll: degrees(Math.atan2(z[1][0], z[0][0])), pitch: degrees(pitch), yaw: degrees(yaw) }
}

const project = (q: number[]): [number, number] => [q[0] / q[2], q[1] / q[2]]

/** Source pixel to corrected pixel. */
export function forward(pitch: number, yaw: number, w: number, h: number, p: Point): Point {
  const L = Math.max(w, h)
  const r = cameraTurn(pitch, yaw)
  const [cx, cy] = project(apply(r, [0, 0, 1]))
  const [x, y] = project(apply(r, [(p.x - w / 2) / L, (p.y - h / 2) / L, 1]))
  return { x: w / 2 + L * (x - cx), y: h / 2 + L * (y - cy) }
}

/** Corrected pixel to source pixel. */
export function inverse(pitch: number, yaw: number, w: number, h: number, p: Point): Point {
  const L = Math.max(w, h)
  const r = cameraTurn(pitch, yaw)
  const [cx, cy] = project(apply(r, [0, 0, 1]))
  const ray = apply(transpose(r), [(p.x - w / 2) / L + cx, (p.y - h / 2) / L + cy, 1])
  const [x, y] = project(ray)
  return { x: w / 2 + L * x, y: h / 2 + L * y }
}

/** The camera ray, in source coordinates, behind a corrected pixel. */
export function sourceRay(pitch: number, yaw: number, w: number, h: number, p: Point): number[] {
  const L = Math.max(w, h)
  const s = inverse(pitch, yaw, w, h, p)
  return [(s.x - w / 2) / L, (s.y - h / 2) / L, 1]
}

/** Where the picture lands in the corrected image: corners clockwise from top left. */
export function pictureQuad(pitch: number, yaw: number, w: number, h: number): Point[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h }
  ].map((p) => forward(pitch, yaw, w, h, p))
}

/** True when `p` is inside the convex, clockwise `quad` (edges count as inside). */
export function insideQuad(quad: Point[], p: Point, tolerance = 1e-6): boolean {
  return quad.every((a, i) => {
    const b = quad[(i + 1) % quad.length]
    return (
      (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >=
      -tolerance * Math.hypot(b.x - a.x, b.y - a.y)
    )
  })
}
