import { describe, it, expect } from 'vitest'
import { cropRect } from '../src/renderer/src/lib/aspectCrop'

describe('cropRect', () => {
  it('crops top/bottom when the target is wider than the frame (21:9 in 640x480)', () => {
    const r = cropRect(640, 480, 5424 / 2328)
    expect(r.sx).toBe(0)
    expect(r.sw).toBe(640)
    expect(r.sh).toBeCloseTo(274.69, 1)
    expect(r.sy).toBeCloseTo((480 - r.sh) / 2, 5)
  })

  it('crops left/right when the target is taller than the frame (1:1 in 640x480)', () => {
    const r = cropRect(640, 480, 1)
    expect(r.sy).toBe(0)
    expect(r.sh).toBe(480)
    expect(r.sw).toBe(480)
    expect(r.sx).toBe(80)
  })

  it('crops 3:2 letterbox (640x424 content)', () => {
    const r = cropRect(640, 480, 3 / 2)
    expect(r.sw).toBe(640)
    expect(r.sh).toBeCloseTo(426.67, 1)
  })

  it('is a no-op when the source already matches the target (within tolerance)', () => {
    expect(cropRect(640, 480, 4 / 3)).toEqual({ sx: 0, sy: 0, sw: 640, sh: 480 })
    // full-res JpgFromRaw is pre-cropped: source AR == target AR
    expect(cropRect(5424, 2328, 5424 / 2328)).toEqual({ sx: 0, sy: 0, sw: 5424, sh: 2328 })
  })

  it('returns the full frame for invalid inputs', () => {
    expect(cropRect(640, 480, 0)).toEqual({ sx: 0, sy: 0, sw: 640, sh: 480 })
    expect(cropRect(0, 0, 1.5)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0 })
    expect(cropRect(640, 480, NaN)).toEqual({ sx: 0, sy: 0, sw: 640, sh: 480 })
  })
})
