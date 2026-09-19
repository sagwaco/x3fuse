import type { ScopeMode } from '@shared/types'

export type ScopePixels = Pick<ImageData, 'data' | 'width' | 'height'>
export const SCOPE_COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#e5e5e5']
export const SKIN_TONE_ANGLE = (123 * Math.PI) / 180

/** Full-range, gamma-encoded Rec.709 signal values; these are preview JPEG scopes. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Unit-circle coordinates: +Cb right, +Cr up. Fit the full chroma square. */
export function chroma(r: number, g: number, b: number): [number, number] {
  const y = luma(r, g, b)
  return [(b - y) / (1.8556 * Math.SQRT1_2), (r - y) / (1.5748 * Math.SQRT1_2)]
}

export const COLOR_TARGETS = [
  { label: 'R', rgb: [0.75, 0, 0] },
  { label: 'Y', rgb: [0.75, 0.75, 0] },
  { label: 'G', rgb: [0, 0.75, 0] },
  { label: 'C', rgb: [0, 0.75, 0.75] },
  { label: 'B', rgb: [0, 0, 0.75] },
  { label: 'M', rgb: [0.75, 0, 0.75] }
] as const

export function histogram(image: ScopePixels): Uint32Array[] {
  const bins = Array.from({ length: 3 }, () => new Uint32Array(256))
  for (let i = 0; i < image.data.length; i += 4) {
    for (let c = 0; c < 3; c++) bins[c][image.data[i + c]]++
  }
  return bins
}

/** Fractional sample coverage retains density without snapping tones to display rows. */
export function scopeDensity(
  image: ScopePixels,
  mode: Exclude<ScopeMode, 'histogram'>,
  width: number,
  height: number
): Float32Array[] {
  const steps = scopeDensitySteps(image, mode, width, height)
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}

/** The fallback renderer can yield between small pieces of the same calculation. */
export function* scopeDensitySteps(
  image: ScopePixels,
  mode: Exclude<ScopeMode, 'histogram'>,
  width: number,
  height: number
): Generator<void, Float32Array[]> {
  const layers = Array.from(
    { length: mode === 'vectorscope' ? 1 : mode === 'waveform' ? 4 : 3 },
    () => new Float32Array(width * height)
  )
  const bin = (value: number, size: number): number =>
    Math.max(0, Math.min(size - 1, Math.round(value * (size - 1))))
  for (let i = 0; i < image.data.length; i += 4) {
    if (i > 0 && i % 4096 === 0) yield
    const r = image.data[i] / 255
    const g = image.data[i + 1] / 255
    const b = image.data[i + 2] / 255
    if (mode === 'vectorscope') {
      const [cb, cr] = chroma(r, g, b)
      layers[0][bin((1 - cr) / 2, height) * width + bin((cb + 1) / 2, width)]++
    } else {
      const sourceX = (i / 4) % image.width
      // Cover the source column's full footprint when shrinking or stretching.
      // Fractional overlap avoids both empty columns and alternating column density.
      const columnWidth = width / image.width
      const xStart = sourceX * columnWidth
      const xEnd = (sourceX + 1) * columnWidth
      const values = [r, g, b, luma(r, g, b)]
      for (let c = 0; c < layers.length; c++) {
        // An 8-bit level covers 1/256 of the signal range. Area-weight that
        // interval into display rows: a uniform ramp stays uniform at any height.
        // This also splits fractional luma levels without discarding their weight.
        const footprint = height / 256
        const yStart = (1 - values[c]) * 255 * footprint
        const yEnd = yStart + footprint
        for (let y = Math.max(0, Math.floor(yStart)); y < Math.min(height, Math.ceil(yEnd)); y++) {
          const weight = (Math.min(y + 1, yEnd) - Math.max(y, yStart)) / footprint
          for (let x = Math.floor(xStart); x < Math.min(width, Math.ceil(xEnd)); x++) {
            const coverage = (Math.min(x + 1, xEnd) - Math.max(x, xStart)) / columnWidth
            layers[c][y * width + x] += weight * coverage
          }
        }
      }
    }
  }
  return layers
}
