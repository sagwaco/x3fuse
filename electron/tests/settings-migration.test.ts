import { describe, it, expect } from 'vitest'
import { normalizeSettings } from '../src/shared/settingsMigration'
import { DEFAULT_SETTINGS } from '@shared/types'

describe('normalizeSettings', () => {
  it('returns defaults for empty / non-object input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('passes through a valid string-union config', () => {
    const input = { ...DEFAULT_SETTINGS, outputFormat: 'tiff', colorProfile: 'adobeRGB' }
    expect(normalizeSettings(input)).toMatchObject({
      outputFormat: 'tiff',
      colorProfile: 'adobeRGB'
    })
  })

  it('maps legacy Int-rawValue enums to string unions', () => {
    // Swift OutputFormat: 0=dng,1=embeddedJpg,2=tiff; ColorProfile: 0..3
    expect(normalizeSettings({ outputFormat: 1 }).outputFormat).toBe('embeddedJpg')
    expect(normalizeSettings({ outputFormat: 2 }).outputFormat).toBe('tiff')
    expect(normalizeSettings({ colorProfile: 2 }).colorProfile).toBe('proPhotoRGB')
    expect(normalizeSettings({ colorProfile: 3 }).colorProfile).toBe('none')
  })

  it('migrates the legacy denoise boolean to an intensity', () => {
    expect(normalizeSettings({ denoise: true }).denoiseIntensity).toBe(10)
    expect(normalizeSettings({ denoise: false }).denoiseIntensity).toBe(0)
    // explicit denoiseIntensity wins over the legacy bool
    expect(normalizeSettings({ denoise: false, denoiseIntensity: 7 }).denoiseIntensity).toBe(7)
  })

  it('clamps denoiseIntensity to 0...10 and rounds', () => {
    expect(normalizeSettings({ denoiseIntensity: 99 }).denoiseIntensity).toBe(10)
    expect(normalizeSettings({ denoiseIntensity: -5 }).denoiseIntensity).toBe(0)
    expect(normalizeSettings({ denoiseIntensity: 3.7 }).denoiseIntensity).toBe(4)
  })

  it('treats an empty / missing output directory as null', () => {
    expect(normalizeSettings({ outputDirectory: '' }).outputDirectory).toBeNull()
    expect(normalizeSettings({ outputDirectory: '/tmp/out' }).outputDirectory).toBe('/tmp/out')
  })

  it('falls back to a valid sort field', () => {
    expect(normalizeSettings({ sortField: 'Bogus' }).sortField).toBe('File Name')
    expect(normalizeSettings({ sortField: 'Size' }).sortField).toBe('Size')
  })

  it('clamps concurrency to 0...MAX and rounds; 0 (auto) is the fallback', () => {
    expect(normalizeSettings({}).concurrency).toBe(0)
    expect(normalizeSettings({ concurrency: 'lots' }).concurrency).toBe(0)
    expect(normalizeSettings({ concurrency: -3 }).concurrency).toBe(0)
    expect(normalizeSettings({ concurrency: 99 }).concurrency).toBe(8)
    expect(normalizeSettings({ concurrency: 2.6 }).concurrency).toBe(3)
    expect(normalizeSettings({ concurrency: 4 }).concurrency).toBe(4)
  })

  it('coerces invalid booleans to their defaults', () => {
    expect(normalizeSettings({ compress: 'yes' }).compress).toBe(DEFAULT_SETTINGS.compress)
    expect(normalizeSettings({ onlyProcessNewItems: 0 }).onlyProcessNewItems).toBe(
      DEFAULT_SETTINGS.onlyProcessNewItems
    )
  })
})
