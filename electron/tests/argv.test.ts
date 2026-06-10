import { describe, it, expect } from 'vitest'
import { buildX3FArgs } from '@shared/argv'
import { DEFAULT_SETTINGS, type ConversionSettings } from '@shared/types'

const IN = '/in/photo.X3F'
const OUT = '/out'
const OPCODES = '/res/opcodes'

function args(overrides: Partial<ConversionSettings>, opcodesDir: string | null = OPCODES) {
  return buildX3FArgs({
    settings: { ...DEFAULT_SETTINGS, ...overrides },
    inputPath: IN,
    outputDir: OUT,
    opcodesDir
  })
}

describe('buildX3FArgs — defaults', () => {
  it('DNG defaults: -o, -v, opcodes, input; no denoise/compress/color', () => {
    // denoise default is 10 so it is omitted; sRGB omits -color.
    expect(args({})).toEqual(['-o', OUT, '-v', '-opcodes-dir', OPCODES, IN])
  })

  it('always starts with -o <dir> -v and ends with the input path', () => {
    const a = args({ outputFormat: 'tiff' })
    expect(a.slice(0, 3)).toEqual(['-o', OUT, '-v'])
    expect(a.at(-1)).toBe(IN)
  })
})

describe('buildX3FArgs — denoise', () => {
  it('omits -denoise at the default of 10', () => {
    expect(args({ denoiseIntensity: 10 })).not.toContain('-denoise')
  })
  it('emits -denoise <n> for any non-10 value (including 0)', () => {
    expect(args({ denoiseIntensity: 0 })).toContain('-denoise')
    expect(args({ denoiseIntensity: 0 })).toEqual(
      expect.arrayContaining(['-denoise', '0'])
    )
    expect(args({ denoiseIntensity: 5 })).toEqual(
      expect.arrayContaining(['-denoise', '5'])
    )
  })
})

describe('buildX3FArgs — compression', () => {
  it('-compress applies to DNG', () => {
    expect(args({ outputFormat: 'dng', compress: true })).toContain('-compress')
  })
  it('-compress applies to TIFF', () => {
    expect(args({ outputFormat: 'tiff', compress: true })).toContain('-compress')
  })
  it('-compress is ignored for embedded JPG', () => {
    expect(args({ outputFormat: 'embeddedJpg', compress: true })).not.toContain('-compress')
  })
})

describe('buildX3FArgs — output format flag', () => {
  it('DNG emits no format flag', () => {
    const a = args({ outputFormat: 'dng' })
    expect(a).not.toContain('-jpg')
    expect(a).not.toContain('-tiff')
  })
  it('embeddedJpg emits -jpg', () => {
    expect(args({ outputFormat: 'embeddedJpg' })).toContain('-jpg')
  })
  it('tiff emits -tiff', () => {
    expect(args({ outputFormat: 'tiff' })).toContain('-tiff')
  })
})

describe('buildX3FArgs — opcodes vs highlight recovery (DNG only, mutually exclusive)', () => {
  it('DNG without highlight recovery includes -opcodes-dir', () => {
    expect(args({ outputFormat: 'dng', dngHighlightRecovery: false })).toEqual(
      expect.arrayContaining(['-opcodes-dir', OPCODES])
    )
  })
  it('DNG with highlight recovery drops opcodes and adds -dng-highlight-recovery', () => {
    const a = args({ outputFormat: 'dng', dngHighlightRecovery: true })
    expect(a).toContain('-dng-highlight-recovery')
    expect(a).not.toContain('-opcodes-dir')
  })
  it('opcodes are not added for JPG/TIFF', () => {
    expect(args({ outputFormat: 'tiff' })).not.toContain('-opcodes-dir')
    expect(args({ outputFormat: 'embeddedJpg' })).not.toContain('-opcodes-dir')
  })
  it('highlight recovery is ignored for non-DNG formats', () => {
    expect(args({ outputFormat: 'tiff', dngHighlightRecovery: true })).not.toContain(
      '-dng-highlight-recovery'
    )
  })
  it('omits -opcodes-dir when no opcodes directory is available', () => {
    expect(args({ outputFormat: 'dng' }, null)).not.toContain('-opcodes-dir')
  })
})

describe('buildX3FArgs — cineon (TIFF only)', () => {
  it('TIFF with cineon emits -cineon', () => {
    expect(args({ outputFormat: 'tiff', cineon: true })).toContain('-cineon')
  })
  it('cineon ignored for DNG', () => {
    expect(args({ outputFormat: 'dng', cineon: true })).not.toContain('-cineon')
  })
})

describe('buildX3FArgs — color profile', () => {
  it('sRGB emits no -color flag', () => {
    expect(args({ colorProfile: 'sRGB' })).not.toContain('-color')
  })
  it('adobeRGB -> -color AdobeRGB', () => {
    expect(args({ colorProfile: 'adobeRGB' })).toEqual(
      expect.arrayContaining(['-color', 'AdobeRGB'])
    )
  })
  it('proPhotoRGB -> -color ProPhotoRGB', () => {
    expect(args({ colorProfile: 'proPhotoRGB' })).toEqual(
      expect.arrayContaining(['-color', 'ProPhotoRGB'])
    )
  })
  it('none -> -color None', () => {
    expect(args({ colorProfile: 'none' })).toEqual(expect.arrayContaining(['-color', 'None']))
  })
})

describe('buildX3FArgs — per-file overrides win over globals', () => {
  it('uses the override format and its flags', () => {
    const a = buildX3FArgs({
      settings: { ...DEFAULT_SETTINGS, outputFormat: 'dng' },
      inputPath: IN,
      outputDir: OUT,
      opcodesDir: OPCODES,
      overrides: { outputFormat: 'tiff', compress: true, colorProfile: 'adobeRGB' }
    })
    expect(a).toContain('-tiff')
    expect(a).toContain('-compress')
    expect(a).toEqual(expect.arrayContaining(['-color', 'AdobeRGB']))
    expect(a).not.toContain('-opcodes-dir') // tiff, not dng
  })
})

describe('buildX3FArgs — exact full orderings', () => {
  it('TIFF + compress + cineon + adobeRGB + denoise 3', () => {
    expect(
      args({
        outputFormat: 'tiff',
        compress: true,
        cineon: true,
        colorProfile: 'adobeRGB',
        denoiseIntensity: 3
      })
    ).toEqual([
      '-o',
      OUT,
      '-v',
      '-denoise',
      '3',
      '-compress',
      '-tiff',
      '-cineon',
      '-color',
      'AdobeRGB',
      IN
    ])
  })

  it('embeddedJpg + proPhotoRGB', () => {
    expect(args({ outputFormat: 'embeddedJpg', colorProfile: 'proPhotoRGB' })).toEqual([
      '-o',
      OUT,
      '-v',
      '-jpg',
      '-color',
      'ProPhotoRGB',
      IN
    ])
  })
})
