import { expect, it } from 'vitest'
import { qualifyMix } from '../src/renderer/src/lib/qualifyMix'

type Sample = [number, number, number]
type Output = 0 | 1 | 2

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const sample: Sample = [0.2, 0.5, 0.9]

function expectQualified(matrix: number[] | null, layers: Sample, output: Output): number[] {
  expect(matrix).not.toBeNull()
  expect(matrix).toHaveLength(9)
  const normalized = layers.map((value) => value / Math.max(...layers))
  for (let row = 0; row < 3; row++) {
    const values = matrix!.slice(row * 3, row * 3 + 3)
    expect(values.every((value) => Number.isFinite(value) && value >= -4 && value <= 4)).toBe(true)
    expect(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1)).toBeLessThan(1e-10)
    const response = values.reduce((sum, value, column) => sum + value * normalized[column], 0)
    expect(Math.abs(response - (row === output ? 1 : 0))).toBeLessThan(1e-10)
  }
  return matrix!
}

it.each([0, 1, 2] as Output[])(
  'qualifies all three rows for output %i and preserves the inputs',
  (output) => {
    const matrix = [...identity]
    const layers: Sample = [...sample]
    expectQualified(qualifyMix(matrix, layers, output), layers, output)
    expect(matrix).toEqual(identity)
    expect(layers).toEqual(sample)
  }
)

it('returns the closest row on each unbounded solution line', () => {
  const matrix = [0.2, -0.4, 1.2, -0.7, 1.8, 0.1, 1.5, 0.1, -0.6]
  const result = expectQualified(qualifyMix(matrix, sample, 1), sample, 1)
  const [a, b, c] = sample.map((value) => value / Math.max(...sample))
  const direction = [c - b, a - c, b - a]
  for (let row = 0; row < 3; row++) {
    const normal = direction.reduce(
      (sum, value, column) => sum + value * (result[row * 3 + column] - matrix[row * 3 + column]),
      0
    )
    expect(Math.abs(normal)).toBeLessThan(1e-10)
  }
})

it('clips the line parameter to the nearest feasible endpoint', () => {
  const layers: Sample = [1, 0.5, 0.25]
  const matrix = [-4, 4, -4, -4, 4, -4, 4, -4, 4]
  const result = expectQualified(qualifyMix(matrix, layers, 0), layers, 0)
  const expected = [-1 / 3, 4, -8 / 3, -5 / 3, 4, -4 / 3, 1, -4, 4]
  result.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12))
})

it.each([0, 1, 2] as Output[])('accepts a feasible boundary sample for output %i', (output) => {
  const layers: Sample = [1, 0.9, 0.775]
  const result = expectQualified(qualifyMix(identity, layers, output), layers, output)
  for (let row = 0; row < 3; row++) {
    if (row !== output) {
      result.slice(row * 3, row * 3 + 3).forEach((value, column) => {
        expect(value).toBeCloseTo([-4, 1, 4][column], 10)
      })
    }
  }
})

it('is invariant to the positive scale of the sampled layers', () => {
  const expected = expectQualified(qualifyMix(identity, sample, 2), sample, 2)
  for (const scale of [1e-200, 1e-100, 0.125, 7, 1e100, 1e200]) {
    const scaled = sample.map((value) => value * scale) as Sample
    const result = expectQualified(qualifyMix(identity, scaled, 2), scaled, 2)
    result.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12))
  }
})

it('handles finite signed matrices, including large current values', () => {
  for (const matrix of [
    [-4, 1, 4, 1, -4, 4, 4, -4, 1],
    [-0.7, 1.2, 0.5, 3, -3, 1, 0, 0, 0],
    [1e308, -1e308, 1e308, -1e308, 1e308, -1e308, 1e308, 1e308, 1e308]
  ]) {
    for (const output of [0, 1, 2] as Output[]) {
      expectQualified(qualifyMix(matrix, sample, output), sample, output)
    }
  }
})

it('keeps the nearest result unchanged by common row offsets', () => {
  const expected = expectQualified(qualifyMix(Array(9).fill(0), sample, 1), sample, 1)
  const matrix = [1e308, 1e308, 1e308, -1e308, -1e308, -1e308, 4, 4, 4]
  const result = expectQualified(qualifyMix(matrix, sample, 1), sample, 1)
  result.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12))
})

it.each([
  [1, 1, 1],
  [1e-200, 1e-200, 1e-200],
  [1, 1 - 1e-12, 1 - 2e-12],
  [1, 0.9, 0.8]
] as Sample[])(
  'rejects neutral or impossible samples %j without changing the target',
  (...layers) => {
    for (const output of [0, 1, 2] as Output[]) {
      expect(qualifyMix(identity, layers, output)).toBeNull()
    }
  }
)

it('rejects invalid matrices, samples, and output indices without throwing', () => {
  for (const matrix of [
    [],
    identity.slice(1),
    [...identity, 0],
    identity.map((value, index) => (index === 2 ? NaN : value)),
    identity.map((value, index) => (index === 4 ? Infinity : value)),
    identity.map((value, index) => (index === 6 ? -Infinity : value)),
    null as unknown as number[]
  ])
    expect(qualifyMix(matrix, sample, 0)).toBeNull()

  for (const layers of [
    [0, 1, 2],
    [-1, 1, 2],
    [0, 0, 0],
    [NaN, 1, 2],
    [1, Infinity, 2],
    [],
    [1, 2],
    [1, 2, 3, 4],
    null
  ])
    expect(qualifyMix(identity, layers as Sample, 0)).toBeNull()

  for (const output of [-1, 3, 0.5, NaN, Infinity]) {
    expect(qualifyMix(identity, sample, output as Output)).toBeNull()
  }
})
