import { expect, it } from 'vitest'
import { curvePath, evaluateCurve } from '../src/shared/curves'
import type { CurvePoint } from '../src/shared/editor'

const points = (values: [number, number][]): CurvePoint[] => values.map(([x, y]) => ({ x, y }))

it('keeps identity and two-point curves linear', () => {
  const identity = points([
    [0, 0],
    [0.125, 0.125],
    [0.625, 0.625],
    [1, 1]
  ])
  const inverted = points([
    [0, 0.9],
    [1, 0.1]
  ])
  for (let i = 0; i <= 100; i++) {
    const x = i / 100
    expect(evaluateCurve(identity, x)).toBeCloseTo(x, 14)
    expect(evaluateCurve(inverted, x)).toBeCloseTo(0.9 - 0.8 * x, 14)
  }
})

it('uses the renderer interpolation values with unequal point spacing', () => {
  const curve = points([
    [0, 0],
    [0.125, 0.375],
    [0.625, 0.75],
    [1, 1]
  ])
  expect(evaluateCurve(curve, 0.0625)).toBeCloseTo(0.2200994318181818, 14)
  for (const point of curve) expect(evaluateCurve(curve, point.x)).toBe(point.y)
  for (const point of curve.slice(1, -1)) {
    const h = 1e-6
    const left = (point.y - evaluateCurve(curve, point.x - h)) / h
    const right = (evaluateCurve(curve, point.x + h) - point.y) / h
    expect(left).toBeCloseTo(right, 4)
  }
})

it('keeps flat, descending, turning and tightly spaced segments finite and within their endpoints', () => {
  for (const curve of [
    points([
      [0, 1],
      [0.125, 0.75],
      [0.625, 0.5],
      [1, 0]
    ]),
    points([
      [0, 0],
      [0.25, 1],
      [0.75, 0],
      [1, 1]
    ]),
    points([
      [0, 0.2],
      [0.125, 0.2],
      [0.625, 0.8],
      [1, 0.8]
    ]),
    points([
      [0, 0],
      [2 ** -149, 1],
      [0.5, 0],
      [1, 1]
    ])
  ]) {
    for (const point of curve) expect(evaluateCurve(curve, point.x)).toBe(point.y)
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1]
      const b = curve[i]
      let previous = a.y
      for (let j = 0; j <= 100; j++) {
        const y = evaluateCurve(curve, a.x + ((b.x - a.x) * j) / 100)
        expect(Number.isFinite(y)).toBe(true)
        expect(y).toBeGreaterThanOrEqual(Math.min(a.y, b.y))
        expect(y).toBeLessThanOrEqual(Math.max(a.y, b.y))
        expect((y - previous) * Math.sign(b.y - a.y)).toBeGreaterThanOrEqual(0)
        previous = y
      }
    }
  }
})

it('draws cubic SVG segments through the same anchors and smooth tangent values', () => {
  const curve = points([
    [0, 0],
    [0.25, 0.5],
    [0.75, 0.5],
    [1, 1]
  ])
  const path = curvePath(curve)
  expect(path.startsWith('M 0 200 C ')).toBe(true)
  expect(path.match(/ C /g)).toHaveLength(3)
  const values = path.match(/[-\d.e+]+/g)!.map(Number)
  const expected = [
    0,
    200,
    (0.25 / 3) * 200,
    200 * (1 - (0.25 / 3) * (8 / 3)),
    (0.25 - 0.25 / 3) * 200,
    100,
    50,
    100,
    (0.25 + 0.5 / 3) * 200,
    100,
    (0.75 - 0.5 / 3) * 200,
    100,
    150,
    100,
    (0.75 + 0.25 / 3) * 200,
    100,
    (1 - 0.25 / 3) * 200,
    200 * (0.25 / 3) * (8 / 3),
    200,
    0
  ]
  expect(values).toHaveLength(expected.length)
  expected.forEach((value, i) => expect(values[i]).toBeCloseTo(value, 12))
  expect(evaluateCurve(curve, 0.125)).toBeCloseTo(1 / 3, 14)
  expect(evaluateCurve(curve, 0.5)).toBe(0.5)
  expect(evaluateCurve(curve, 0.875)).toBeCloseTo(2 / 3, 14)
})
