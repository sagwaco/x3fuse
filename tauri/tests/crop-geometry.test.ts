import { expect, it } from 'vitest'
import { pictureQuad } from '../src/renderer/src/lib/perspective'
import {
  SNAP,
  centeredCrop,
  cropToFrame,
  dragFrame,
  fitCrop,
  fitDrag,
  frameToCrop,
  matchAspect,
  ratioCrop,
  sweptAngle,
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

it('keeps the frame inside the perspective picture outline', () => {
  const quad = pictureQuad(20, 0, W, H)
  const full = cropToFrame({ x: 0, y: 0, width: 1, height: 1 }, 0, W, H)
  expect(frameToCrop(full, 0, W, H)).not.toBeNull()
  expect(frameToCrop(full, 0, W, H, quad)).toBeNull()
  const small = { x: 500, y: 300, width: 200, height: 200 }
  expect(frameToCrop(small, 0, W, H, quad)).not.toBeNull()
  // The outline turns with the picture when it is straightened.
  expect(frameToCrop(small, 30, W, H, quad)).not.toBeNull()
  // Pitch pulls one pair of corners in; a small frame in that pair is out, the other pair is in.
  const corners = [
    { x: 0, y: 0, width: 200, height: 200 },
    { x: W - 200, y: H - 200, width: 200, height: 200 }
  ]
  const outside = corners.filter((frame) => frameToCrop(frame, 0, W, H, quad) === null)
  expect(outside.length).toBeGreaterThan(0)
})

it('shrinks a crop about its center until it fits the outline', () => {
  const crop = { x: 0, y: 0, width: 1, height: 1 }
  expect(fitCrop(crop, 0, 0, 0, W, H)).toBe(crop)
  const fitted = fitCrop(crop, 3, 15, -10, W, H)
  expect(fitted.width).toBeLessThan(1)
  expect(fitted.width / fitted.height).toBeCloseTo(1)
  const quad = pictureQuad(15, -10, W, H)
  expect(frameToCrop(cropToFrame(fitted, 3, W, H), 3, W, H, quad)).not.toBeNull()
  // Larger than the fit by a little would not fit.
  const bigger = { ...fitted, x: fitted.x - 0.02, y: fitted.y - 0.02 }
  bigger.width += 0.04
  bigger.height += 0.04
  expect(frameToCrop(cropToFrame(bigger, 3, W, H), 3, W, H, quad)).toBeNull()
})

it('finds the largest centered crop of an aspect for a perspective picture', () => {
  const crop = centeredCrop(3 / 2, 0, 0, 0, W, H)!
  close(crop, { x: 0, y: 0, width: 1, height: 1 })
  const turned = centeredCrop(3 / 2, 2, 10, 5, W, H)!
  expect((turned.width * W) / (turned.height * H)).toBeGreaterThan(0)
  expect(turned.width).toBeLessThan(1)
  expect(turned.x + turned.width / 2).toBeCloseTo(0.5, 1)
})

it('turns the picture by the swept angle and snaps with Shift', () => {
  const center = { x: 0, y: 0 }
  const from = { x: 100, y: 0 }
  // A clockwise sweep on screen (y down) is a positive angle.
  expect(sweptAngle(0, from, { x: 0, y: 100 }, center, false)).toBe(45)
  expect(sweptAngle(2, from, { x: 100, y: 10 }, center, false)).toBeCloseTo(2 + 5.7106, 3)
  expect(sweptAngle(0, from, { x: 100, y: 10 }, center, true)).toBe(0)
  expect(sweptAngle(0, from, { x: 100, y: 30 }, center, true)).toBe(SNAP)
  expect(sweptAngle(0, from, { x: 100, y: -30 }, center, true)).toBe(-SNAP)
  // Crossing the half turn does not jump by 360 degrees.
  expect(sweptAngle(0, { x: -100, y: 1 }, { x: -100, y: -1 }, center, false)).toBeCloseTo(1.146, 2)
})
