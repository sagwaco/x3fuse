import { describe, expect, it } from 'vitest'
import {
  chroma,
  COLOR_TARGETS,
  histogram,
  luma,
  scopeDensity,
  SKIN_TONE_ANGLE
} from '../src/renderer/src/lib/scopes'

function pixels(rgb: number[][], width = rgb.length) {
  return {
    data: new Uint8ClampedArray(rgb.flatMap((pixel) => [...pixel, 255])),
    width,
    height: rgb.length / width
  }
}

describe('preview scopes', () => {
  it('counts every grayscale bin, including black and white', () => {
    const image = pixels(Array.from({ length: 256 }, (_, i) => [i, i, i]))
    for (const channel of histogram(image)) expect([...channel]).toEqual(new Array(256).fill(1))
    const layers = scopeDensity(image, 'waveform', 256, 256)
    for (const layer of layers) {
      for (let x = 0; x < 256; x++) expect(layer[(255 - x) * 256 + x]).toBe(1)
      expect(layer.reduce((a, b) => a + b)).toBeCloseTo(256, 6)
    }
  })

  it('keeps horizontal positions and channel levels in RGB parade and waveform', () => {
    const image = pixels([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255]
    ])
    const parade = scopeDensity(image, 'rgbParade', 3, 256)
    for (let c = 0; c < 3; c++) {
      expect(parade[c][c]).toBe(1)
      expect(parade[c][255 * 3 + c]).toBe(0)
      expect(parade[c][255 * 3 + ((c + 1) % 3)]).toBe(1)
    }
    const waveform = scopeDensity(image, 'waveform', 3, 256)
    expect(waveform.slice(0, 3)).toEqual(parade)
    for (const [x, value] of [0.2126, 0.7152, 0.0722].entries()) {
      let total = 0
      let position = 0
      for (let y = 0; y < 256; y++) {
        total += waveform[3][y * 3 + x]
        position += y * waveform[3][y * 3 + x]
      }
      expect(total).toBeCloseTo(1, 6)
      expect(position / total).toBeCloseTo((1 - value) * 255, 5)
    }
    expect(luma(1, 1, 1)).toBeCloseTo(1)
  })

  it('accumulates density and handles a one-column image', () => {
    const layers = scopeDensity(
      pixels(
        [
          [255, 0, 0],
          [255, 0, 0]
        ],
        1
      ),
      'rgbParade',
      1,
      256
    )
    expect(layers[0][0]).toBe(2)
    expect(layers[1][255]).toBe(2)
    expect(layers[2][255]).toBe(2)
  })

  it('keeps a uniform ramp equally dense at every display height without losing samples', () => {
    const image = pixels(
      Array.from({ length: 256 }, (_, i) => [i, i, i]),
      1
    )
    for (const mode of ['waveform', 'rgbParade'] as const) {
      for (const height of [1, 100, 166, 255, 256, 333, 512]) {
        for (const layer of scopeDensity(image, mode, 1, height)) {
          for (const count of layer) expect(count).toBeCloseTo(256 / height, 5)
          expect(layer.reduce((a, b) => a + b)).toBeCloseTo(256, 4)
        }
      }
    }
  })

  it('preserves black/white endpoints and sample weight for single tones', () => {
    for (const height of [1, 166, 333]) {
      for (const value of [0, 54, 128, 191, 255]) {
        for (const layer of scopeDensity(pixels([[value, value, value]]), 'waveform', 1, height)) {
          expect(layer.reduce((a, b) => a + b)).toBeCloseTo(1, 6)
          const occupied = [...layer].flatMap((count, y) => (count > 1e-6 ? [y] : []))
          expect(occupied.length).toBeLessThanOrEqual(Math.ceil(height / 256) + 1)
          if (value === 255) expect(occupied[0]).toBe(0)
          if (value === 0) expect(occupied.at(-1)).toBe(height - 1)
        }
      }
    }
  })

  it('keeps constant images equally dense across columns when shrinking and stretching', () => {
    for (const mode of ['waveform', 'rgbParade'] as const) {
      for (const sourceWidth of [1, 160, 213, 320]) {
        const image = pixels(Array.from({ length: sourceWidth }, () => [128, 128, 128]))
        for (const width of [74, 230, 400]) {
          for (const layer of scopeDensity(image, mode, width, 166)) {
            for (let x = 0; x < width; x++) {
              let column = 0
              for (let y = 0; y < 166; y++) column += layer[y * width + x]
              expect(column).toBeCloseTo(sourceWidth / width, 5)
            }
            expect(layer.reduce((a, b) => a + b)).toBeCloseTo(sourceWidth, 4)
          }
        }
      }
    }
  })

  it('fills every display column when waveform or parade is wider than its source', () => {
    for (const mode of ['waveform', 'rgbParade'] as const) {
      for (const sourceWidth of [1, 2, 160, 213, 320]) {
        const image = pixels(
          Array.from({ length: sourceWidth }, (_, x) =>
            x < sourceWidth / 2 ? [255, 255, 255] : [0, 0, 0]
          )
        )
        for (const width of [74, 230, 400]) {
          for (const layer of scopeDensity(image, mode, width, 256)) {
            for (let x = 0; x < width; x++) {
              expect(layer[x] + layer[255 * width + x]).toBeGreaterThan(0)
            }
            expect(layer[0]).toBeGreaterThan(0)
            if (sourceWidth > 1) expect(layer[256 * width - 1]).toBeGreaterThan(0)
          }
        }
      }
    }
  })

  it('centers neutrals and maps color bars onto the matching vectorscope targets', () => {
    const neutral = pixels([
      [0, 0, 0],
      [128, 128, 128],
      [255, 255, 255]
    ])
    expect(scopeDensity(neutral, 'vectorscope', 101, 101)[0][50 * 101 + 50]).toBe(3)
    expect(chroma(1, 0, 0)[0]).toBeLessThan(0)
    expect(chroma(1, 0, 0)[1]).toBeGreaterThan(0)
    expect(chroma(0, 0, 1)[0]).toBeGreaterThan(0)
    expect(chroma(0, 0, 1)[1]).toBeLessThan(0)
    const bars = pixels(COLOR_TARGETS.map(({ rgb }) => rgb.map((value) => Math.round(value * 255))))
    const density = scopeDensity(bars, 'vectorscope', 101, 101)[0]
    for (const { rgb } of COLOR_TARGETS) {
      const [cb, cr] = chroma(rgb[0], rgb[1], rgb[2])
      const x = Math.round((cb + 1) * 50)
      const y = Math.round((1 - cr) * 50)
      // 75% lies between 8-bit values: the rounded JPEG sample is within one plot pixel.
      let nearby = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) nearby += density[(y + dy) * 101 + x + dx]
      }
      expect(nearby).toBe(1)
    }
    const red = chroma(0.75, 0, 0)
    const yellow = chroma(0.75, 0.75, 0)
    expect(SKIN_TONE_ANGLE).toBeGreaterThan(Math.atan2(red[1], red[0]))
    expect(SKIN_TONE_ANGLE).toBeLessThan(Math.atan2(yellow[1], yellow[0]))
  })
})
