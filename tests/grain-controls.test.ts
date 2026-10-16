import { describe, expect, it } from 'vitest'
import { grainRmsBase, type GrainParams } from '../src/shared/editor'

describe('grain RMS base', () => {
  const grain: GrainParams = { rmsGranularity: [3, 6, 9], blur: 0.89, multUsmAmount: 1.5 }

  it('uses the saved base, including zero', () => {
    expect(grainRmsBase({ ...grain, rmsBase: 5 })).toBe(5)
    expect(grainRmsBase({ ...grain, rmsBase: 0 }, true)).toBe(0)
  })

  it('uses the mean for color and the first channel for monochrome without metadata', () => {
    expect(grainRmsBase(grain)).toBe(6)
    expect(grainRmsBase(grain, true)).toBe(3)
    expect(grain.rmsGranularity).toEqual([3, 6, 9])
  })
})
