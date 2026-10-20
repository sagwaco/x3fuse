import type { ScopeMode, ThemeName } from '@shared/types'

export type ScopePixels = Pick<ImageData, 'data' | 'width' | 'height'>

export interface ScopePalette {
  /** Red, green, blue and luma traces. */
  channels: [string, string, string, string]
  vector: string
  grid: string
  rings: string
  label: string
  target: string
  skin: string
  /** How the density traces combine with the surface and with each other. */
  blend: GlobalCompositeOperation
  /** The opacity of the densest trace. Multiplied traces need more to show. */
  density: number
}

/**
 * Scope colors on each theme surface. On dark, light traces add up. On light and gray,
 * dark traces multiply, so overlaps get darker as ink does. Labels keep 4.5:1.
 */
export const SCOPE_PALETTES: Record<ThemeName, ScopePalette> = {
  dark: {
    channels: ['#ef4444', '#22c55e', '#3b82f6', '#e5e5e5'],
    vector: '#d4e5dc',
    grid: '#404040',
    rings: '#737373',
    label: '#facc15',
    target: '#a3a3a3',
    skin: '#d4a574',
    blend: 'lighter',
    density: 0.6
  },
  light: {
    channels: ['#dc2626', '#16a34a', '#2563eb', '#404040'],
    vector: '#1f3d2e',
    grid: '#d4d4d4',
    rings: '#a3a3a3',
    label: '#a16207',
    target: '#525252',
    skin: '#b45309',
    blend: 'multiply',
    density: 0.85
  },
  gray: {
    channels: ['#6b1414', '#0d3d20', '#172e70', '#0a0a0a'],
    vector: '#10241a',
    grid: '#505050',
    rings: '#4a4a4a',
    label: '#0a0a0a',
    target: '#222222',
    skin: '#7c2d12',
    blend: 'multiply',
    density: 1
  }
}
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
  const { data, width: imageWidth } = image
  const layers = Array.from(
    { length: mode === 'vectorscope' ? 1 : mode === 'waveform' ? 4 : 3 },
    () => new Float32Array(width * height)
  )
  if (mode === 'vectorscope') {
    const bin = (value: number, size: number): number =>
      Math.max(0, Math.min(size - 1, Math.round(value * (size - 1))))
    for (let i = 0; i < data.length; i += 4) {
      if (i > 0 && i % 65536 === 0) yield
      const [cb, cr] = chroma(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255)
      layers[0][bin((1 - cr) / 2, height) * width + bin((cb + 1) / 2, width)]++
    }
    return layers
  }
  // Cover the source column's full footprint when shrinking or stretching.
  // Fractional overlap avoids both empty columns and alternating column density.
  const columnWidth = width / imageWidth
  // An 8-bit level covers 1/256 of the signal range. Area-weight that interval into
  // display rows: a uniform ramp stays uniform at any height. This also splits
  // fractional luma levels without discarding their weight.
  const footprint = height / 256
  const splat = (layer: Float32Array, sourceX: number, level: number, weight: number): void => {
    const xStart = sourceX * columnWidth
    const xEnd = (sourceX + 1) * columnWidth
    const yStart = (255 - level) * footprint
    const yEnd = yStart + footprint
    for (let y = Math.max(0, Math.floor(yStart)); y < Math.min(height, Math.ceil(yEnd)); y++) {
      const rowWeight = (weight * (Math.min(y + 1, yEnd) - Math.max(y, yStart))) / footprint
      for (let x = Math.floor(xStart); x < Math.min(width, Math.ceil(xEnd)); x++) {
        const coverage = (Math.min(x + 1, xEnd) - Math.max(x, xStart)) / columnWidth
        layer[y * width + x] += rowWeight * coverage
      }
    }
  }
  // Same column and 8-bit level means the same footprint: count R, G and B per
  // column first, then splat each occupied level once instead of once per pixel.
  const counts = new Uint32Array(imageWidth * 3 * 256)
  for (let i = 0; i < data.length; i += 4) {
    if (i > 0 && i % 65536 === 0) yield
    const sourceX = (i / 4) % imageWidth
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    counts[sourceX * 768 + r]++
    counts[sourceX * 768 + 256 + g]++
    counts[sourceX * 768 + 512 + b]++
    if (mode === 'waveform') splat(layers[3], sourceX, luma(r, g, b), 1)
  }
  for (let sourceX = 0; sourceX < imageWidth; sourceX++) {
    if (sourceX > 0 && sourceX % 64 === 0) yield
    for (let c = 0; c < 3; c++) {
      for (let level = 0; level < 256; level++) {
        const count = counts[sourceX * 768 + c * 256 + level]
        if (count) splat(layers[c], sourceX, level, count)
      }
    }
  }
  return layers
}
