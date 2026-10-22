import { expect, it } from 'vitest'
import {
  MIX_BOUNDARY,
  mixPoint,
  pointMix,
  mixPadPoint,
  padPointMix,
  type LayerMix
} from '../src/renderer/src/lib/ternaryMix'

const expectMix = (actual: LayerMix, expected: LayerMix): void => {
  actual.forEach((value, channel) => expect(value).toBeCloseTo(expected[channel], 12))
}

const corners: LayerMix[] = [
  [-4, 1, 4],
  [1, -4, 4],
  [4, -4, 1],
  [4, 1, -4],
  [1, 4, -4],
  [-4, 4, 1]
]

it('places equal weights at the origin and the reference layers at their vertices', () => {
  expect(mixPoint([1 / 3, 1 / 3, 1 / 3])).toEqual({ x: 0, y: 0 })
  expectMix(pointMix({ x: 0, y: 0 }), [1 / 3, 1 / 3, 1 / 3])
  for (const [mix, point] of [
    [[1, 0, 0], { x: 0, y: 1 }],
    [[0, 1, 0], { x: -Math.sqrt(3) / 2, y: -0.5 }],
    [[0, 0, 1], { x: Math.sqrt(3) / 2, y: -0.5 }]
  ] as [LayerMix, { x: number; y: number }][]) {
    expect(mixPoint(mix)).toEqual(point)
    expectMix(pointMix(point), mix)
  }
})

it('maps loaded values without normalization, clamping, or mutation', () => {
  const mix: LayerMix = [2, -1, 3]
  expect(mixPoint(mix)).toEqual({ x: 2 * Math.sqrt(3), y: 1 })
  expect(mix).toEqual([2, -1, 3])
  expect(mixPoint([5, 0, 0])).toEqual({ x: 0, y: 5 })
})

it('round-trips negative mixes and the full supported domain', () => {
  for (let bottom = -4; bottom <= 4; bottom += 0.125) {
    for (let middle = -4; middle <= 4; middle += 0.125) {
      const top = 1 - bottom - middle
      if (top >= -4 && top <= 4) {
        const mix: LayerMix = [bottom, middle, top]
        expectMix(pointMix(mixPoint(mix)), mix)
      }
    }
  }
})

it('exports all six boundary corners in perimeter order', () => {
  expect(MIX_BOUNDARY).toHaveLength(6)
  MIX_BOUNDARY.forEach((point, index) => {
    expect(point).toEqual(mixPoint(corners[index]))
    expectMix(pointMix(point), corners[index])
    const next = MIX_BOUNDARY[(index + 1) % 6]
    const after = MIX_BOUNDARY[(index + 2) % 6]
    expect(
      (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x)
    ).toBeGreaterThan(0)
  })
})

it('projects perpendicularly onto every edge and keeps each edge unchanged', () => {
  corners.forEach((start, index) => {
    const end = corners[(index + 1) % corners.length]
    const midpoint = start.map((value, channel) => (value + end[channel]) / 2) as LayerMix
    const fixed = start.findIndex((value, channel) => value === end[channel])
    const outside = midpoint.map(
      (value, channel) =>
        value + (channel === fixed ? Math.sign(value) * 2 : -Math.sign(midpoint[fixed]))
    ) as LayerMix
    expectMix(pointMix(mixPoint(midpoint)), midpoint)
    expectMix(pointMix(mixPoint(outside)), midpoint)
  })
})

it('projects outside each corner to that corner', () => {
  corners.forEach((corner, index) => {
    const previous = corners[(index + 5) % 6]
    const next = corners[(index + 1) % 6]
    const outside = corner.map((value, channel) => 3 * value - previous[channel] - next[channel])
    expectMix(pointMix(mixPoint(outside as LayerMix)), corner)
  })
})

it('returns the nearest valid mix with bounded weights that sum to one', () => {
  for (let x = -20; x <= 20; x += 2) {
    for (let y = -20; y <= 20; y += 2) {
      const mix = pointMix({ x, y })
      expect(mix.every((value) => value >= -4 && value <= 4)).toBe(true)
      expect(mix.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12)
      expectMix(pointMix(mixPoint(mix)), mix)
      const projected = mixPoint(mix)
      for (const candidate of [...MIX_BOUNDARY, { x: 0, y: 0 }]) {
        expect(
          (x - projected.x) * (candidate.x - projected.x) +
            (y - projected.y) * (candidate.y - projected.y)
        ).toBeLessThanOrEqual(1e-10)
      }
    }
  }
})

it('enlarges the reference triangle 3.5 times while keeping its center and signed boundaries fixed', () => {
  expect(mixPadPoint([1 / 3, 1 / 3, 1 / 3])).toEqual({ x: 0, y: 0 })
  expectMix(padPointMix({ x: 0, y: 0 }), [1 / 3, 1 / 3, 1 / 3])
  for (const vertex of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ] as LayerMix[]) {
    const linear = mixPoint(vertex)
    const display = mixPadPoint(vertex)
    expect(display.x).toBeCloseTo(linear.x * 3.5)
    expect(display.y).toBeCloseTo(linear.y * 3.5)
    expectMix(padPointMix(display), vertex)
  }
  for (const corner of corners) {
    const display = mixPadPoint(corner)
    const linear = mixPoint(corner)
    expect(display.x).toBeCloseTo(linear.x)
    expect(display.y).toBeCloseTo(linear.y)
  }
})

it('round-trips the enlarged pad throughout the signed range without changing bounds or total', () => {
  for (let bottom = -4; bottom <= 4; bottom += 0.25) {
    for (let middle = -4; middle <= 4; middle += 0.25) {
      const top = 1 - bottom - middle
      if (top < -4 || top > 4) continue
      const mix: LayerMix = [bottom, middle, top]
      expectMix(padPointMix(mixPadPoint(mix)), mix)
    }
  }
  for (const p of [
    { x: 100, y: 100 },
    { x: -100, y: 0 },
    { x: 0, y: -100 }
  ]) {
    const mix = padPointMix(p)
    expect(mix.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
    expect(mix.every((v) => v >= -4 && v <= 4)).toBe(true)
  }
})

it('is continuous across the enlarged triangle and monotonic toward every signed edge', () => {
  for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 24) {
    let last = -1
    for (let radius = 0; radius < 14; radius += 0.05) {
      const p = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
      const bottom = (1 + 2 * p.y) / 3
      const middle = (1 - bottom) / 2 - p.x / Math.sqrt(3)
      const display = mixPadPoint([bottom, middle, 1 - bottom - middle])
      const distance = Math.hypot(display.x, display.y)
      expect(distance).toBeGreaterThan(last)
      last = distance
    }
  }
  for (const bottom of [1 - 1e-8, 1, 1 + 1e-8]) {
    expect(mixPadPoint([bottom, (1 - bottom) / 2, (1 - bottom) / 2]).y).toBeCloseTo(3.5, 6)
  }
})

it('keeps outside projection at the boundary point nearest the displayed pointer', () => {
  for (const p of [
    { x: 7.9, y: -3 },
    { x: 3, y: 7.3 },
    { x: 2, y: 11 }
  ]) {
    expectMix(padPointMix(p), pointMix(p))
  }
})
