import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EFFECTS,
  DEFAULT_FILM,
  IDENTITY_RAW_MATRIX,
  RAW_GAIN_RANGE,
  defaultRecipe,
  pasteRecipe,
  type EditRecipe,
  type RawColor
} from '@shared/editor'
import { EDITOR_SECTIONS, editorSection, resetSection } from '@shared/editorSections'

const rawRecipe = (): EditRecipe => ({
  ...defaultRecipe(),
  film: null,
  temperature: 4200,
  tint: 15,
  rawColor: {
    gains: [2, 1, 0.5],
    matrix: [0, 0, 1, 0, 1, 0, 1, 0, 0]
  }
})
const sourceRaw: RawColor = {
  gains: [0.5, 1, 3],
  matrix: [1, 0.25, -0.5, 0.1, 1, 0.2, 0, 0, 1]
}

describe('raw color sections', () => {
  it('defines the raw defaults and clears raw color on Reset All', () => {
    expect(IDENTITY_RAW_MATRIX).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
    expect(RAW_GAIN_RANGE).toEqual([1 / 64, 64])
    expect(defaultRecipe()).toHaveProperty('rawColor', null)
    const reset = { ...rawRecipe(), ...defaultRecipe(), cameraProfile: 'Standard' }
    expect(reset.rawColor).toBeNull()
    expect(reset.cameraProfile).toBe('Standard')
  })

  it('copies raw white balance gains without the matrix or visible white balance', () => {
    const source = { ...rawRecipe(), rawColor: structuredClone(sourceRaw), temperature: 6000 }
    const target = rawRecipe()
    const patch = EDITOR_SECTIONS.whiteBalance.take(source, target)
    expect(patch).toEqual({ rawColor: { ...target.rawColor, gains: sourceRaw.gains } })
    expect(patch.rawColor!.gains).not.toBe(source.rawColor.gains)
    expect({ ...target, ...patch }).toMatchObject({ temperature: 4200, tint: 15 })
  })

  it('resets raw white balance to the photo gains and keeps the channel matrix', () => {
    const target = rawRecipe()
    const defaults = {
      ...defaultRecipe(),
      rawColor: { gains: [1.5, 1, 0.75] as RawColor['gains'], matrix: [...IDENTITY_RAW_MATRIX] }
    }
    expect(resetSection(EDITOR_SECTIONS.whiteBalance, target, defaults)).toEqual({
      rawColor: { ...target.rawColor, gains: defaults.rawColor.gains }
    })
    expect(resetSection(EDITOR_SECTIONS.whiteBalance, target, defaultRecipe())).toEqual({})
  })

  it('copies and resets visible white balance with temperature and tint', () => {
    const source = { ...defaultRecipe(), temperature: 6000, tint: -20 }
    const target = { ...defaultRecipe(), rawColor: undefined }
    expect(EDITOR_SECTIONS.whiteBalance.take(source, target)).toEqual({
      temperature: 6000,
      tint: -20,
      whiteBalanceGains: null
    })
    expect(resetSection(EDITOR_SECTIONS.whiteBalance, source, defaultRecipe())).toEqual({
      temperature: null,
      tint: 0,
      whiteBalanceGains: null
    })
  })

  it('copies direct gains without aliasing and clears a target override with a normal balance', () => {
    const source = {
      ...defaultRecipe(),
      whiteBalanceGains: [3, 1, 0.25] as [number, number, number]
    }
    const target = { ...defaultRecipe(), whiteBalanceGains: [1, 1, 1] as [number, number, number] }
    const copied = EDITOR_SECTIONS.whiteBalance.take(source, target)
    expect(copied.whiteBalanceGains).toEqual(source.whiteBalanceGains)
    expect(copied.whiteBalanceGains).not.toBe(source.whiteBalanceGains)
    expect(EDITOR_SECTIONS.whiteBalance.take(defaultRecipe(), target).whiteBalanceGains).toBeNull()
    expect(
      resetSection(EDITOR_SECTIONS.whiteBalance, source, defaultRecipe()).whiteBalanceGains
    ).toBeNull()
  })

  it.each([
    ['raw to visible', rawRecipe(), defaultRecipe()],
    ['visible to raw', defaultRecipe(), rawRecipe()]
  ] as const)(
    'leaves white balance and channels unchanged for %s paste',
    (_name, source, target) => {
      expect(EDITOR_SECTIONS.whiteBalance.take(source, target)).toEqual({})
      expect(EDITOR_SECTIONS.channels.take(source, target)).toEqual({})
    }
  )

  it('copies only the channel matrix between raw recipes', () => {
    const source = { ...rawRecipe(), rawColor: structuredClone(sourceRaw) }
    const target = rawRecipe()
    const patch = EDITOR_SECTIONS.channels.take(source, target)
    expect(editorSection('channels')).toBe(EDITOR_SECTIONS.channels)
    expect(patch).toEqual({ rawColor: { ...target.rawColor, matrix: sourceRaw.matrix } })
    expect(patch.rawColor!.matrix).not.toBe(source.rawColor.matrix)
  })

  it('resets channels to identity while preserving gains', () => {
    const target = rawRecipe()
    const patch = resetSection(EDITOR_SECTIONS.channels, target, defaultRecipe())
    expect(patch).toEqual({ rawColor: { ...target.rawColor, matrix: IDENTITY_RAW_MATRIX } })
    expect(patch.rawColor!.matrix).not.toBe(IDENTITY_RAW_MATRIX)
    expect(resetSection(EDITOR_SECTIONS.channels, defaultRecipe(), defaultRecipe())).toEqual({})
    expect(EDITOR_SECTIONS.channels.take(defaultRecipe(), defaultRecipe())).toEqual({})
  })

  it('copies a raw look with its gains and matrix and keeps the target effects', () => {
    const source = rawRecipe()
    const target = {
      ...defaultRecipe(),
      cameraProfile: 'Monochrome',
      monochrome: { filter: 'red' as const },
      film: { ...DEFAULT_FILM, grain: false, evFilm: 1.5 }
    }
    const patch = EDITOR_SECTIONS.look.take(source, target)
    expect(patch).toMatchObject({
      rawColor: source.rawColor,
      cameraProfile: null,
      monochrome: null,
      film: null,
      effects: {
        grain: false,
        grainParams: DEFAULT_FILM.grainParams,
        halation: DEFAULT_FILM.halation,
        halationParams: DEFAULT_FILM.halationParams
      }
    })
    expect(patch.rawColor).not.toBe(source.rawColor)
    expect(patch.rawColor!.matrix).not.toBe(source.rawColor!.matrix)
    expect(patch).not.toHaveProperty('temperature')
    expect(patch).not.toHaveProperty('tint')
  })

  it('copies a raw look matrix while preserving the target white balance gains', () => {
    const source = { ...rawRecipe(), rawColor: structuredClone(sourceRaw) }
    const target = rawRecipe()
    const patch = EDITOR_SECTIONS.look.take(source, target)
    expect(patch.rawColor).toEqual({ gains: target.rawColor!.gains, matrix: sourceRaw.matrix })
    expect(patch.rawColor!.gains).not.toBe(target.rawColor!.gains)
    expect(patch.rawColor!.matrix).not.toBe(source.rawColor.matrix)
    expect(source.rawColor).toEqual(sourceRaw)
  })

  it.each([null, undefined])(
    'clears raw color when a visible camera look has rawColor %s',
    (rawColor) => {
      const source: EditRecipe = {
        ...defaultRecipe(),
        rawColor,
        film: null,
        cameraProfile: 'Standard'
      }
      const target = { ...rawRecipe(), effects: { ...DEFAULT_EFFECTS, grain: true } }
      const patch = EDITOR_SECTIONS.look.take(source, target)
      expect(patch).toMatchObject({ rawColor: null, cameraProfile: 'Standard', monochrome: null })
      expect(patch).not.toHaveProperty('effects')
      expect({ ...target, ...patch }.effects).toEqual(target.effects)
    }
  )

  it('clears raw color for a film look while preserving the target effects', () => {
    const source = defaultRecipe()
    const target = { ...rawRecipe(), effects: { ...DEFAULT_EFFECTS, grain: true, halation: true } }
    expect(EDITOR_SECTIONS.look.take(source, target)).toMatchObject({
      rawColor: null,
      film: { ...DEFAULT_FILM, ...target.effects }
    })
  })

  it('resets a raw look to the camera defaults', () => {
    const defaults = { ...defaultRecipe(), film: null, cameraProfile: 'Standard' }
    expect(resetSection(EDITOR_SECTIONS.look, rawRecipe(), defaults)).toEqual({
      film: null,
      cameraProfile: 'Standard',
      monochrome: null,
      rawColor: null
    })
  })

  it('does not paste a monochrome filter onto raw color', () => {
    const source: EditRecipe = { ...defaultRecipe(), monochrome: { filter: 'red' } }
    expect(EDITOR_SECTIONS.filter.take(source, rawRecipe())).toEqual({})
  })
})

describe('raw color adjustment paste', () => {
  it('copies raw settings and retains the target geometry, seed, and X3I source', () => {
    const source = rawRecipe()
    const target: EditRecipe = {
      ...defaultRecipe(),
      cameraProfile: 'Standard',
      crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      rotation: 2,
      straighten: 5,
      pitch: 3,
      yaw: -2,
      seed: 42,
      x3iSource: 'merge'
    }
    const pasted = pasteRecipe(source, target)
    expect(pasted).toEqual({
      ...source,
      crop: target.crop,
      rotation: target.rotation,
      straighten: target.straighten,
      pitch: target.pitch,
      yaw: target.yaw,
      seed: target.seed,
      x3iSource: target.x3iSource
    })
    expect(pasted.rawColor).not.toBe(source.rawColor)
    expect(pasted.rawColor!.gains).not.toBe(source.rawColor!.gains)
    expect(pasted.rawColor!.matrix).not.toBe(source.rawColor!.matrix)
  })

  it.each([null, undefined])(
    'clears raw mode when pasted visible settings have rawColor %s',
    (rawColor) => {
      const source = { ...defaultRecipe(), cameraProfile: 'Standard', rawColor }
      const pasted = pasteRecipe(source, rawRecipe())
      expect(pasted.rawColor).toBe(rawColor)
      expect(pasted.cameraProfile).toBe('Standard')
    }
  )
})
