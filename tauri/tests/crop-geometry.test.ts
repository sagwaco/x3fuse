import { expect, it } from 'vitest'
import {
  cropToFrame,
  dragFrame,
  fitDrag,
  frameToCrop,
  matchAspect,
  ratioCrop,
  zoom,
  type Rect
} from '../src/renderer/src/lib/cropGeometry'

const W = 1200
const H = 800
const close = (a: Rect | null, b: Rect): void => {
  expect(a).not.toBeNull()
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(a![key]).toBeCloseTo(b[key], 5)
}

it('maps crops to straightened frames and back', () => {
  const crop = { x: 0.2, y: 0.15, width: 0.5, height: 0.6 }
  const pixels = cropToFrame(crop, 0, W, H)
  close(
    { x: pixels.x / W, y: pixels.y / H, width: pixels.width / W, height: pixels.height / H },
    crop
  )
  for (const degrees of [-31, -4.5, 0, 7, 45])
    close(frameToCrop(cropToFrame(crop, degrees, W, H), degrees, W, H), crop)
  // Straightening a full crop zooms in about the image center, like the renderer.
  const frame = cropToFrame({ x: 0, y: 0, width: 1, height: 1 }, 10, W, H)
  expect(frame.width).toBeCloseTo(W / zoom(1.5, 10))
  expect(frame.x + frame.width / 2).toBeCloseTo(W / 2)
  expect(frameToCrop({ ...frame, x: frame.x + 50 }, 10, W, H)).toBeNull()
})

it('slides a dragged frame along the image edge and keeps locked ratios', () => {
  const start = cropToFrame({ x: 0.5, y: 0.25, width: 0.25, height: 0.25 }, 0, W, H)
  const crop = (dx: number, dy: number): Rect | null =>
    frameToCrop(dragFrame(start, 'move', dx, dy), 0, W, H)
  close(fitDrag(crop, 1000, 100), { x: 0.75, y: 0.375, width: 0.25, height: 0.25 })
  const locked = dragFrame(start, 'se', 120, 10, 1.5)
  expect(locked.width / locked.height).toBeCloseTo(1.5)
  expect([locked.x, locked.y]).toEqual([start.x, start.y])
  const side = dragFrame(start, 'w', -60, 0, 1.5)
  expect(side.y + side.height / 2).toBeCloseTo(start.y + start.height / 2)
})

it('recognizes camera framing and presets in either orientation', () => {
  const asShot = { x: 0, y: 0.05, width: 1, height: 0.9 }
  expect(matchAspect(asShot, asShot, 0, W, H)).toBe('asShot')
  expect(matchAspect(ratioCrop(16 / 9, 0, W, H), asShot, 0, W, H)).toBe('16:9')
  expect(matchAspect(ratioCrop(2 / 3, 1, W, H), asShot, 1, W, H)).toBe('3:2')
  expect(matchAspect({ x: 0, y: 0, width: 0.3, height: 0.71 }, asShot, 0, W, H)).toBe('free')
})
