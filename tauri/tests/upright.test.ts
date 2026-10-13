import { describe, expect, it } from 'vitest'
import {
  apply,
  cameraTurn,
  decompose,
  inverse,
  multiply,
  rotationZ,
  transpose
} from '../src/renderer/src/lib/perspective'
import type { Mat3, Point } from '../src/renderer/src/lib/perspective'
import { level, upright } from '../src/renderer/src/lib/upright'
import type { Picture } from '../src/renderer/src/lib/upright'

const W = 600
const H = 400

function blank(w: number, h: number, gray: number): Picture {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set([gray, gray, gray, 255], i * 4)
  return { data, width: w, height: h }
}

/** Draw an anti-aliased bright segment, about 3 px wide. */
function segment(pic: Picture, a: Point, b: Point): void {
  const [dx, dy] = [b.x - a.x, b.y - a.y]
  const len2 = dx * dx + dy * dy
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - 3))
  const x1 = Math.min(pic.width - 1, Math.ceil(Math.max(a.x, b.x) + 3))
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - 3))
  const y1 = Math.min(pic.height - 1, Math.ceil(Math.max(a.y, b.y) + 3))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2))
      const d = Math.hypot(x - a.x - t * dx, y - a.y - t * dy)
      const cover = Math.max(0, Math.min(1, 2 - d))
      const k = (y * pic.width + x) * 4
      const v = pic.data[k] + (230 - pic.data[k]) * cover
      pic.data.set([v, v, v], k)
    }
  }
}

/** Source pixel of a pixel in the ideal (upright) view, for a total camera turn. */
function toSource(turn: Mat3, p: Point): Point {
  const L = Math.max(W, H)
  const q = apply(transpose(turn), [(p.x - W / 2) / L, (p.y - H / 2) / L, 1])
  return { x: W / 2 + (L * q[0]) / q[2], y: H / 2 + (L * q[1]) / q[2] }
}

/** A grid of vertical and horizontal lines in the ideal view, seen through `turn`. */
function grid(turn: Mat3, vertical = true, horizontal = true, reach = 0): Picture {
  const pic = blank(W, H, 90)
  if (vertical) {
    for (const x of [80, 170, 260, 350, 440, 530]) {
      segment(pic, toSource(turn, { x, y: 40 - reach }), toSource(turn, { x, y: 360 + reach }))
    }
  }
  if (horizontal) {
    for (const y of [60, 140, 220, 300]) {
      segment(pic, toSource(turn, { x: 40 - reach, y }), toSource(turn, { x: 560 + reach, y }))
    }
  }
  return pic
}

/** Render the source as the renderer does: outside the picture the edge pixels repeat. */
function warp(src: Picture, pitch: number, yaw: number): Picture {
  const out = blank(W, H, 0)
  const edge = (v: number, size: number): number => Math.max(0, Math.min(size - 1.001, v))
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = inverse(pitch, yaw, W, H, { x, y })
      const [cx, cy] = [edge(s.x, W), edge(s.y, H)]
      const [sx, sy] = [Math.floor(cx), Math.floor(cy)]
      const [fx, fy] = [cx - sx, cy - sy]
      const at = (i: number, j: number): number => src.data[((sy + j) * W + sx + i) * 4]
      const v =
        at(0, 0) * (1 - fx) * (1 - fy) +
        at(1, 0) * fx * (1 - fy) +
        at(0, 1) * (1 - fx) * fy +
        at(1, 1) * fx * fy
      out.data.set([v, v, v, 255], (y * W + x) * 4)
    }
  }
  return out
}

const NONE = { pitch: 0, yaw: 0 }

describe('level', () => {
  it('levels a tilted horizon', () => {
    for (const tilt of [3.2, -5, 0.6, 35, -44]) {
      const pic = blank(640, 400, 0)
      for (let y = 0; y < 400; y++) {
        for (let x = 0; x < 640; x++) {
          const d =
            (y - (200 + (x - 320) * Math.tan((tilt * Math.PI) / 180))) *
            Math.cos((tilt * Math.PI) / 180)
          const v = 70 + 120 * Math.max(0, Math.min(1, 0.5 - d))
          pic.data.set([v, v, v, 255], (y * 640 + x) * 4)
        }
      }
      // Right side lower on screen is a clockwise tilt, so straighten turns it back.
      expect(Math.abs((level(pic, NONE, 640, 400) as number) + tilt)).toBeLessThan(0.5)
    }
  })

  it('levels a rotated grid from its vertical lines', () => {
    const pic = grid(rotationZ(4) as Mat3, true, false)
    expect(Math.abs((level(pic, NONE, W, H) as number) - 4)).toBeLessThan(0.5)
  })

  it('returns null for a featureless picture', () => {
    expect(level(blank(500, 300, 128), NONE, 500, 300)).toBeNull()
    expect(upright(blank(500, 300, 128), { pitch: 0, yaw: 0 }, 500, 300)).toBeNull()
  })
})

describe('upright', () => {
  const expectAngles = (
    got: { straighten: number; pitch: number; yaw: number } | null,
    want: { roll: number; pitch: number; yaw: number },
    tolerance = 1
  ): void => {
    expect(got).not.toBeNull()
    expect(Math.abs((got as { pitch: number }).pitch - want.pitch)).toBeLessThan(tolerance)
    expect(Math.abs((got as { yaw: number }).yaw - want.yaw)).toBeLessThan(tolerance)
    expect(Math.abs((got as { straighten: number }).straighten - want.roll)).toBeLessThan(tolerance)
  }

  it('recovers pitch from converging verticals', () => {
    const turn = cameraTurn(11, 0)
    expectAngles(upright(grid(turn), { pitch: 0, yaw: 0 }, W, H), decompose(turn))
  })

  it('recovers roll, pitch and yaw together', () => {
    const turn = multiply(rotationZ(-3), cameraTurn(8, -5))
    expectAngles(upright(grid(turn), { pitch: 0, yaw: 0 }, W, H), decompose(turn))
  })

  it('works from verticals alone and keeps the yaw', () => {
    const turn = multiply(rotationZ(2), cameraTurn(-9, 0))
    expectAngles(upright(grid(turn, true, false), { pitch: 0, yaw: 0 }, W, H), decompose(turn))
  })

  it.each([
    ['roll, pitch and yaw', multiply(rotationZ(-3), cameraTurn(8, -5))],
    ['a strong pitch', cameraTurn(20, 0)],
    ['a strong yaw', cameraTurn(0, 15)]
  ])('gives the same angles from a picture it already corrected: %s', (_name, turn) => {
    const src = grid(turn)
    const first = upright(src, { pitch: 0, yaw: 0 }, W, H)
    // The first run recovers the true angles, so no edge pair of a line may pull its fit.
    expectAngles(first, decompose(turn))
    const again = upright(
      warp(src, first!.pitch, first!.yaw),
      { pitch: first!.pitch, yaw: first!.yaw },
      W,
      H
    )
    expectAngles(again, { roll: first!.straighten, pitch: first!.pitch, yaw: first!.yaw }, 0.7)
  })

  it('scales a smaller picture to the source size', () => {
    const turn = cameraTurn(11, 0)
    const src = grid(turn)
    // Same view, half the pixels.
    const half = blank(W / 2, H / 2, 0)
    for (let y = 0; y < H / 2; y++) {
      for (let x = 0; x < W / 2; x++) {
        const v = src.data[(2 * y * W + 2 * x) * 4]
        half.data.set([v, v, v, 255], (y * (W / 2) + x) * 4)
      }
    }
    expectAngles(upright(half, { pitch: 0, yaw: 0 }, W, H), decompose(turn), 1.5)
  })

  it('limits pitch and yaw', () => {
    const got = upright(grid(cameraTurn(30, 0)), { pitch: 0, yaw: 0 }, W, H)
    expect(got).not.toBeNull()
    expect(got!.pitch).toBeLessThanOrEqual(25)
    expect(Object.values(got!).every(Number.isFinite)).toBe(true)
  })

  it('is not biased by the smeared border of a rendered picture', () => {
    const turn = multiply(rotationZ(3), cameraTurn(12, 0))
    // Lines run past the photo edges, so the render smears them outside the picture.
    const src = grid(turn, true, true, 300)
    const current = { pitch: 12, yaw: 0 }
    const pic = warp(src, 12, 0)
    expect(Math.abs((level(pic, current, W, H) as number) - 3)).toBeLessThan(0.7)
    const first = upright(pic, current, W, H)
    expectAngles(first, decompose(turn))
    const again = upright(warp(src, first!.pitch, first!.yaw), first!, W, H)
    expectAngles(again, { roll: first!.straighten, pitch: first!.pitch, yaw: first!.yaw }, 0.7)
  })
})

/** Deterministic pseudo random numbers in [0, 1). */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

/** A horizon of the given tilt: `top` above it, `bottom` below, 1 px soft edge. */
function horizon(w: number, h: number, tilt: number, top: number, bottom: number): Picture {
  const pic = blank(w, h, 0)
  const slope = Math.tan((tilt * Math.PI) / 180)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (y - (h / 2 + (x - w / 2) * slope)) * Math.cos((tilt * Math.PI) / 180)
      const v = bottom + (top - bottom) * Math.max(0, Math.min(1, 0.5 - d))
      pic.data.set([v, v, v, 255], (y * w + x) * 4)
    }
  }
  return pic
}

describe('real photo failure modes', () => {
  it('lets one long horizon beat random short clutter', () => {
    const pic = horizon(800, 533, 1.5, 190, 120)
    const next = random(7)
    for (let i = 0; i < 60; i++) {
      const [x, y, angle, len] = [next() * 800, next() * 533, next() * Math.PI, 20 + next() * 80]
      const to = { x: x + Math.cos(angle) * len, y: y + Math.sin(angle) * len }
      segment(pic, { x, y }, to)
    }
    expect(Math.abs((level(pic, NONE, 800, 533) as number) + 1.5)).toBeLessThan(0.3)
  })

  it('levels a faint horizon in a dark picture', () => {
    const pic = horizon(800, 533, -2, 14, 7)
    expect(Math.abs((level(pic, NONE, 800, 533) as number) - 2)).toBeLessThan(0.4)
  })

  it('returns null for foliage-like noise', () => {
    const next = random(3)
    const pic = blank(800, 532, 0)
    for (let i = 0; i < 800 * 532; i++) {
      const v = 40 + next() * 140
      pic.data.set([v, v, v], i * 4)
    }
    expect(level(pic, NONE, 800, 532)).toBeNull()
    expect(upright(pic, NONE, 800, 532)).toBeNull()
  })

  it('levels only, when few lines agree on perspective', () => {
    // One long horizontal and one vertical line: no perspective can be trusted.
    const pic = horizon(800, 533, 1, 190, 100)
    segment(pic, { x: 400, y: 50 }, { x: 405, y: 480 })
    const got = upright(pic, NONE, 800, 531)
    expect(got).not.toBeNull()
    expect(got!.pitch).toBe(0)
    expect(got!.yaw).toBe(0)
    expect(Math.abs(got!.straighten + 1)).toBeLessThan(0.4)
  })

  it('ignores a big yaw from slanted horizontal lines', () => {
    // Converging horizontals like a shore line fan: not a crooked camera.
    const pic = blank(600, 400, 90)
    for (const [y0, y1] of [
      [40, 120],
      [120, 150],
      [200, 190],
      [280, 250],
      [360, 280]
    ]) {
      segment(pic, { x: 20, y: y0 }, { x: 580, y: y1 })
    }
    const got = upright(pic, NONE, 600, 400)
    expect(got === null || Math.abs(got.yaw) <= 12).toBe(true)
  })
})
