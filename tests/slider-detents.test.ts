import { expect, it } from 'vitest'
import { detent } from '../src/renderer/src/lib/detent'

it('snaps drags onto nearby detents and clicks once per detent reached or crossed', () => {
  const detents = [-10, 0, 10]
  expect(detent(-5, -0.5, detents, 1)).toEqual({ value: 0, click: true })
  expect(detent(0, 0.8, detents, 1)).toEqual({ value: 0, click: false })
  expect(detent(0, 3, detents, 1)).toEqual({ value: 3, click: false })
  expect(detent(3, 4, detents, 1)).toEqual({ value: 4, click: false })
  expect(detent(4, 12, detents, 1)).toEqual({ value: 12, click: true })
  expect(detent(12, -4, detents, 1)).toEqual({ value: -4, click: true })
})
