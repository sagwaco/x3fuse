import { expect, it } from 'vitest'
import {
  cameraTurn,
  decompose,
  forward,
  insideQuad,
  inverse,
  multiply,
  pictureQuad,
  rotationZ
} from '../src/renderer/src/lib/perspective'

// Reference values shared with x3f-render geometry.rs; keep both in sync.
const cases = [
  {
    pitch: 12,
    yaw: 0,
    w: 6000,
    h: 4000,
    quad: [
      [-300.8976, -249.7611],
      [6300.8976, -249.7611],
      [5864.0944, 3952.0533],
      [135.9056, 3952.0533]
    ],
    forward: [1216.3463, 2356.2333],
    inverse: [1138.3547, 634.2771]
  },
  {
    pitch: 0,
    yaw: -9,
    w: 4000,
    h: 6000,
    quad: [
      [-164.4426, -206.6921],
      [3947.3607, 114.9218],
      [3947.3607, 5885.0782],
      [-164.4426, 6206.6921]
    ],
    forward: [1198.5793, 2323.1491],
    inverse: [1048.9623, 592.7688]
  },
  {
    pitch: -15,
    yaw: 7,
    w: 6000,
    h: 4000,
    quad: [
      [202.2386, 124.2573],
      [5998.2838, -99.6523],
      [6795.9072, 4544.9437],
      [-174.8024, 4223.2655]
    ],
    forward: [1193.2278, 2365.0212],
    inverse: [934.5895, 455.6806]
  }
]

it('matches the renderer reference values and round-trips', () => {
  for (const c of cases) {
    const quad = pictureQuad(c.pitch, c.yaw, c.w, c.h)
    quad.forEach((p, i) => {
      expect(p.x).toBeCloseTo(c.quad[i][0], 3)
      expect(p.y).toBeCloseTo(c.quad[i][1], 3)
    })
    const f = forward(c.pitch, c.yaw, c.w, c.h, { x: 1234, y: 2345 })
    expect([f.x, f.y].map((v) => +v.toFixed(3))).toEqual(c.forward.map((v) => +v.toFixed(3)))
    const back = inverse(c.pitch, c.yaw, c.w, c.h, f)
    expect(back.x).toBeCloseTo(1234, 6)
    expect(back.y).toBeCloseTo(2345, 6)
    const i = inverse(c.pitch, c.yaw, c.w, c.h, { x: 1000, y: 500 })
    expect(i.x).toBeCloseTo(c.inverse[0], 3)
    expect(i.y).toBeCloseTo(c.inverse[1], 3)
    // The image center stays in place.
    const center = forward(c.pitch, c.yaw, c.w, c.h, { x: c.w / 2, y: c.h / 2 })
    expect(center.x).toBeCloseTo(c.w / 2, 6)
    expect(center.y).toBeCloseTo(c.h / 2, 6)
  }
  const identity = forward(0, 0, 6000, 4000, { x: 1234, y: 2345 })
  expect(identity).toEqual({ x: 1234, y: 2345 })
})

it('splits a camera turn back into roll, pitch and yaw', () => {
  const r = multiply(rotationZ(-4.5), cameraTurn(11, -6))
  const angles = decompose(r)
  expect(angles.roll).toBeCloseTo(-4.5, 9)
  expect(angles.pitch).toBeCloseTo(11, 9)
  expect(angles.yaw).toBeCloseTo(-6, 9)
})

it('tests points against the picture outline', () => {
  const quad = pictureQuad(12, 0, 6000, 4000)
  expect(insideQuad(quad, { x: 3000, y: 2000 })).toBe(true)
  // The bottom narrows: the source's bottom left corner area is now empty.
  expect(insideQuad(quad, { x: 60, y: 3900 })).toBe(false)
  expect(insideQuad(quad, { x: 6000, y: 0 })).toBe(true)
})
