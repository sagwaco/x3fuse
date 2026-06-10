import { describe, it, expect } from 'vitest'
import { parseExif } from '../src/main/services/ExifService'

describe('parseExif', () => {
  it('parses model, numeric aperture (1 decimal), and string lensId', () => {
    const out = JSON.stringify([
      { SourceFile: 'a.X3F', Model: 'SIGMA DP2 Merrill', Aperture: 2.8, LensID: 'DP2 Merrill 30mm' }
    ])
    const r = parseExif(out)
    expect(r.cameraModel).toBe('SIGMA DP2 Merrill')
    expect(r.aperture).toBe('2.8')
    expect(r.lensId).toBe('DP2 Merrill 30mm')
    expect(r.raw.SourceFile).toBe('a.X3F')
  })

  it('formats numeric aperture to one decimal', () => {
    expect(parseExif(JSON.stringify([{ Aperture: 4 }])).aperture).toBe('4.0')
    expect(parseExif(JSON.stringify([{ Aperture: 5.6 }])).aperture).toBe('5.6')
  })

  it('accepts a string aperture verbatim', () => {
    expect(parseExif(JSON.stringify([{ Aperture: '2.8' }])).aperture).toBe('2.8')
  })

  it('formats a numeric LensID like the Swift fallback', () => {
    expect(parseExif(JSON.stringify([{ LensID: 32776 }])).lensId).toBe('Unknown_(32776)_30mm')
  })

  it('leaves missing fields undefined', () => {
    const r = parseExif(JSON.stringify([{ SourceFile: 'x' }]))
    expect(r.cameraModel).toBeUndefined()
    expect(r.aperture).toBeUndefined()
    expect(r.lensId).toBeUndefined()
  })

  it('throws on invalid / empty JSON', () => {
    expect(() => parseExif('not json')).toThrow()
    expect(() => parseExif('[]')).toThrow()
  })
})
