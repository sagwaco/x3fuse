import { expect, it } from 'vitest'
import { defaultRecipe, pasteRecipe, type EditRecipe } from './editor'

it('pastes the camera look while retaining the target framing and seed', () => {
  const source: EditRecipe = { ...defaultRecipe(), cameraProfile: 'FCBlue', film: null }
  const target: EditRecipe = {
    ...defaultRecipe(),
    cameraProfile: 'ForestGreen',
    crop: { x: 0, y: 0.1, width: 1, height: 0.8 },
    rotation: 1,
    seed: 123
  }
  const pasted = pasteRecipe(source, target)
  expect(pasted.cameraProfile).toBe('FCBlue')
  expect(pasted.film).toBeNull()
  expect(pasted.crop).toEqual(target.crop)
  expect(pasted.rotation).toBe(target.rotation)
  expect(pasted.seed).toBe(target.seed)
})

it('keeps legacy recipes valid without adding a camera look', () => {
  const legacy = defaultRecipe()
  delete legacy.cameraProfile
  expect(pasteRecipe(legacy, defaultRecipe()).cameraProfile).toBeUndefined()
  expect(defaultRecipe().cameraProfile).toBeNull()
})
