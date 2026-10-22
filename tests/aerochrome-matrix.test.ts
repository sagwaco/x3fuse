import { expect, it } from 'vitest'
import { AEROCHROME_MATRIX } from '@shared/editor'
import patches from '../src/shared/aerochrome-patches.json'

const output = (sample: (typeof patches.samples)[number], name: string): number[] => {
  const neutral = patches.samples
    .find((entry) => entry.file === sample.neutralFile)!
    .patches.find((patch) => patch.name === 'cloud')!.meanLayers
  const layers = sample.patches
    .find((patch) => patch.name === name)!
    .meanLayers.map((value, channel) => value / neutral[channel])
  return [0, 1, 2].map((row) =>
    layers.reduce((sum, value, column) => sum + value * AEROCHROME_MATRIX[row * 3 + column], 0)
  )
}
const hsv = (linear: number[]): { hue: number; saturation: number } => {
  const peak = Math.max(1, ...linear)
  const rgb = linear.map((value) => {
    const x = Math.max(0, value / peak)
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
  })
  const [r, g, b] = rgb
  const max = Math.max(...rgb),
    min = Math.min(...rgb),
    delta = max - min
  const sector = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return {
    hue: delta === 0 ? 0 : (sector * 60 + 360) % 360,
    saturation: max === 0 ? 0 : delta / max
  }
}

it('keeps the empirical Aerochrome mix within recipe limits and preserves a picked neutral', () => {
  expect(AEROCHROME_MATRIX).toHaveLength(9)
  expect(AEROCHROME_MATRIX.every((value) => Number.isFinite(value) && Math.abs(value) <= 4)).toBe(
    true
  )
  for (const row of [0, 1, 2])
    expect(AEROCHROME_MATRIX.slice(row * 3, row * 3 + 3).reduce((a, b) => a + b, 0)).toBeCloseTo(
      1,
      12
    )
  for (const sample of patches.samples.filter((entry) => entry.file === entry.neutralFile))
    output(sample, 'cloud').forEach((value) => expect(value).toBeCloseTo(1, 12))
})

it('keeps development and independent foliage patches red to orange before film', () => {
  for (const sample of patches.samples) {
    const color = hsv(output(sample, 'foliage'))
    expect(color.hue >= 330 || color.hue <= 40, `${sample.file}: ${color.hue}`).toBe(true)
    expect(color.saturation).toBeGreaterThan(0.2)
  }
})

it('renders the development clear sky blue and permits cyan in the hazy check scene', () => {
  const clear = hsv(output(patches.samples[0], 'sky'))
  expect(clear.hue).toBeGreaterThan(195)
  expect(clear.hue).toBeLessThan(220)
  const hazy = hsv(output(patches.samples[2], 'sky'))
  expect(hazy.hue).toBeGreaterThan(180)
  expect(hazy.hue).toBeLessThan(240)
  const cloud = output(patches.samples[0], 'cloud-check')
  expect((Math.max(...cloud) - Math.min(...cloud)) / Math.max(...cloud)).toBeLessThan(0.04)
})
