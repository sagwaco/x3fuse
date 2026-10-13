import { expect, it } from 'vitest'
import {
  CELL,
  coveredCells,
  isNative,
  nextPrefetch,
  type PreviewCache
} from '../src/renderer/src/lib/previewTiles'

const W = 4704
const H = 3136
const render = (x: number, y: number, w: number, h: number): PreviewCache['renders'][number] => ({
  url: `${x},${y}`,
  region: { x: x / W, y: y / H, width: w / W, height: h / H }
})
const cache = (...renders: PreviewCache['renders']): PreviewCache => ({
  key: 'k',
  width: W,
  height: H,
  renders
})
/** The pixel rectangle the renderer makes of a region (floor and ceil, as geometry.rs). */
const f32 = Math.fround
const rendered = (r: { x: number; y: number; width: number; height: number }): number[] => [
  Math.floor(f32(f32(r.x) * W)),
  Math.floor(f32(f32(r.y) * H)),
  Math.ceil(f32(f32(f32(r.x) + f32(r.width)) * W)),
  Math.ceil(f32(f32(f32(r.y) + f32(r.height)) * H))
]

it('tells native region renders from scaled ones', () => {
  const base = { sessionId: 's', revision: 1, url: 'u', fullWidth: W, fullHeight: H }
  const region = { x: 0.1, y: 0.2, width: 1000 / W, height: 800 / H }
  expect(isNative({ ...base, width: 1000, height: 800, region })).toBe(true)
  expect(isNative({ ...base, width: 870, height: 696, region })).toBe(false)
  expect(isNative({ ...base, width: 2048, height: 1365 })).toBe(false)
})

it('counts only cells that a render covers completely, including the short last cells', () => {
  const covered = coveredCells(cache(render(256, 0, 600, 512), render(4352, 2816, 352, 320)))
  // 256..856 holds column 1 (256..512) and column 2 (512..768), not column 3.
  // 4352..4704 x 2816..3136 holds columns 17 and 18 (short) of rows 11 and 12 (short).
  expect([...covered].sort()).toEqual(
    ['1,0', '1,1', '2,0', '2,1', '17,11', '18,11', '17,12', '18,12'].sort()
  )
  // The image is 4704 x 3136: column 18 and row 12 are short.
  expect(coveredCells(cache(render(4608, 3072, 96, 64))).has('18,12')).toBe(true)
})

it('prefetches the nearest uncovered block around the viewport, cell aligned', () => {
  const viewport = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }
  const visible = render(1881, 1254, 941, 628)
  const first = nextPrefetch(cache(visible), viewport, new Set())!
  // Blocks are 1024 px; the viewport centre (2352, 1568) is in block (2, 1).
  const [x0, y0, x1, y1] = rendered(first)
  expect([x0 % CELL, y0 % CELL]).toEqual([0, 0])
  expect(x1 % CELL === 0 || x1 === W).toBe(true)
  expect(y1 % CELL === 0 || y1 === H).toBe(true)
  expect(x0 >= 2048 && x1 <= 3072 && y0 >= 1024 && y1 <= 2048).toBe(true)
  // Skipped (failed) blocks are passed over; covered areas are never requested again.
  const second = nextPrefetch(cache(visible), viewport, new Set([JSON.stringify(first)]))!
  expect(second).not.toEqual(first)
  const all = cache(visible, render(0, 0, W, H))
  expect(nextPrefetch(all, viewport, new Set())).toBeNull()
})

it('stays inside the image and the grown viewport at the edges', () => {
  const viewport = { x: 0.8, y: 0.8, width: 0.2, height: 0.2 }
  let state = cache()
  const seen: number[][] = []
  for (let i = 0; i < 50; ++i) {
    const next = nextPrefetch(state, viewport, new Set())
    if (!next) break
    const [x0, y0, x1, y1] = rendered(next)
    seen.push([x0, y0, x1, y1])
    expect(next.x + next.width).toBeLessThanOrEqual(1)
    expect(next.y + next.height).toBeLessThanOrEqual(1)
    state = cache(...state.renders, render(x0, y0, x1 - x0, y1 - y0))
  }
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.length).toBeLessThan(50)
  // The ring reaches from 0.7 to the image edge.
  expect(Math.min(...seen.map(([x0]) => x0))).toBeLessThanOrEqual(0.7 * W)
  expect(Math.min(...seen.map(([x0]) => x0))).toBeGreaterThan(0.7 * W - CELL)
  expect(Math.max(...seen.map(([, , x1]) => x1))).toBe(W)
  expect(Math.max(...seen.map(([, , , y1]) => y1))).toBe(H)
})
