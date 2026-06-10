import { describe, it, expect } from 'vitest'
import {
  drawImageWithOrientation,
  needsOrientation,
  shouldUseCanvas
} from '../src/renderer/src/lib/orientation'

/**
 * Records the 2D-context calls so we can assert the canonical EXIF-orientation
 * transform matrix and the width/height swap without a real canvas.
 */
function fakeCanvas(): {
  canvas: HTMLCanvasElement
  transforms: number[][]
  draws: number[][]
} {
  const transforms: number[][] = []
  const draws: number[][] = []
  const ctx = {
    setTransform: (...a: number[]) => transforms.push(a),
    drawImage: (_img: unknown, ...a: number[]) => draws.push(a)
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx
  }
  return { canvas: canvas as unknown as HTMLCanvasElement, transforms, draws }
}

const bitmap = (w: number, h: number): ImageBitmap =>
  ({ width: w, height: h, close: () => {} }) as unknown as ImageBitmap

describe('needsOrientation', () => {
  it('is false for absent/normal, true for 2..8', () => {
    expect(needsOrientation(undefined)).toBe(false)
    expect(needsOrientation(1)).toBe(false)
    for (let o = 2; o <= 8; o++) expect(needsOrientation(o)).toBe(true)
  })
})

describe('shouldUseCanvas', () => {
  it('never uses the canvas for the self-orienting, pre-cropped full variant', () => {
    // Regression guard: the full-res JpgFromRaw must render as an <img> the
    // browser orients — routing it through the canvas double-rotates it.
    expect(shouldUseCanvas('full', 6, 4704 / 3136)).toBe(false)
    expect(shouldUseCanvas('full', 8, 5424 / 2328)).toBe(false)
    expect(shouldUseCanvas('full', 1, 3 / 2)).toBe(false)
    expect(shouldUseCanvas('full', undefined, undefined)).toBe(false)
  })

  it('uses the canvas for a rotated preview', () => {
    expect(shouldUseCanvas('preview', 6, 4 / 3)).toBe(true)
    expect(shouldUseCanvas('preview', 8, undefined)).toBe(true)
  })

  it('uses the canvas for a non-4:3 preview that needs letterbox cropping', () => {
    expect(shouldUseCanvas('preview', 1, 21 / 9)).toBe(true)
    expect(shouldUseCanvas('preview', 1, 1)).toBe(true)
  })

  it('skips the canvas for an upright ~4:3 preview', () => {
    expect(shouldUseCanvas('preview', 1, 4 / 3)).toBe(false)
    expect(shouldUseCanvas('preview', undefined, undefined)).toBe(false)
  })
})

describe('drawImageWithOrientation', () => {
  it('orientation 1: no swap, identity matrix, full-frame source', () => {
    const f = fakeCanvas()
    drawImageWithOrientation(f.canvas, bitmap(640, 480), 1)
    expect([f.canvas.width, f.canvas.height]).toEqual([640, 480])
    expect(f.transforms[0]).toEqual([1, 0, 0, 1, 0, 0])
    // drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
    expect(f.draws[0]).toEqual([0, 0, 640, 480, 0, 0, 640, 480])
  })

  it('orientation 3 (180°): no swap, flips both axes', () => {
    const f = fakeCanvas()
    drawImageWithOrientation(f.canvas, bitmap(640, 480), 3)
    expect([f.canvas.width, f.canvas.height]).toEqual([640, 480])
    expect(f.transforms[0]).toEqual([-1, 0, 0, -1, 640, 480])
  })

  it('orientation 6 (90° CW): swaps to portrait', () => {
    const f = fakeCanvas()
    drawImageWithOrientation(f.canvas, bitmap(640, 480), 6)
    expect([f.canvas.width, f.canvas.height]).toEqual([480, 640])
    expect(f.transforms[0]).toEqual([0, 1, -1, 0, 480, 0])
  })

  it('orientation 8 (270° CW): swaps to portrait', () => {
    const f = fakeCanvas()
    drawImageWithOrientation(f.canvas, bitmap(640, 480), 8)
    expect([f.canvas.width, f.canvas.height]).toEqual([480, 640])
    expect(f.transforms[0]).toEqual([0, -1, 1, 0, 0, 640])
  })

  it('downscales so the longest edge respects maxEdge (and still swaps)', () => {
    const f = fakeCanvas()
    drawImageWithOrientation(f.canvas, bitmap(4704, 3136), 6, { maxEdge: 1800 })
    // 4704 * (1800/4704) = 1800 wide, 1200 tall pre-rotation -> canvas 1200x1800
    expect([f.canvas.width, f.canvas.height]).toEqual([1200, 1800])
    expect(f.draws[0]).toEqual([0, 0, 4704, 3136, 0, 0, 1800, 1200])
  })

  it('crops the aspect-ratio letterbox (21:9 in a 640x480 preview)', () => {
    const f = fakeCanvas()
    drawImageWithOrientation(f.canvas, bitmap(640, 480), 1, { aspectRatio: 5424 / 2328 })
    // content is 640 x ~274.7, centered vertically (bars top/bottom)
    expect(f.canvas.width).toBe(640)
    expect(f.canvas.height).toBe(275)
    const [sx, sy, sw, sh] = f.draws[0]
    expect([sx, sw, sh]).toEqual([0, 640, 480 - 2 * sy])
    expect(sy).toBeCloseTo(102.65, 1)
  })
})
