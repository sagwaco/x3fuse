import type { PreviewRegion, RenderedPreview } from '@shared/editor'

/**
 * Native-resolution renders of one recipe, kept while the photo is zoomed so
 * that panning shows sharp pixels. Coverage uses cells of CELL native output
 * pixels; prefetch requests one block of at most BLOCK pixels per side.
 */
export interface PreviewCache {
  /** The session and the exact recipe the renders used. */
  key: string
  /** Native output size (RenderedPreview fullWidth and fullHeight). */
  width: number
  height: number
  renders: Array<{ url: string; region: PreviewRegion }>
}

export const CELL = 256
const BLOCK = 1024
/** Older renders fall out after this many; their cells become uncovered again. */
export const MAX_RENDERS = 64

/** True when a region render has one output pixel for each native pixel. */
export function isNative(preview: RenderedPreview): boolean {
  const { region, fullWidth, fullHeight } = preview
  return (
    !!region &&
    !!fullWidth &&
    !!fullHeight &&
    Math.abs(preview.width / region.width - fullWidth) < 0.5 &&
    Math.abs(preview.height / region.height - fullHeight) < 0.5
  )
}

type Rect = { x0: number; y0: number; x1: number; y1: number }
const pixels = (region: PreviewRegion, width: number, height: number): Rect => ({
  x0: Math.round(region.x * width),
  y0: Math.round(region.y * height),
  x1: Math.round((region.x + region.width) * width),
  y1: Math.round((region.y + region.height) * height)
})

/** Cells (column, row) that some render covers completely. */
export function coveredCells(cache: PreviewCache): Set<string> {
  const covered = new Set<string>()
  const columns = Math.ceil(cache.width / CELL)
  const rows = Math.ceil(cache.height / CELL)
  for (const render of cache.renders) {
    const r = pixels(render.region, cache.width, cache.height)
    for (let row = Math.ceil(r.y0 / CELL); row < rows; ++row) {
      if (Math.min(cache.height, (row + 1) * CELL) > r.y1) break
      for (let column = Math.ceil(r.x0 / CELL); column < columns; ++column) {
        if (Math.min(cache.width, (column + 1) * CELL) > r.x1) break
        covered.add(`${column},${row}`)
      }
    }
  }
  return covered
}

/**
 * The next region to prefetch: the nearest block around the viewport (grown by
 * half its size on each side) with cells that no render covers. The region is
 * moved 0.25 px inside its pixel edges, so the renderer's floor and ceil land
 * exactly on them. Returns null when the area is covered.
 */
export function nextPrefetch(
  cache: PreviewCache,
  viewport: PreviewRegion,
  skip: Set<string>
): PreviewRegion | null {
  const { width, height } = cache
  const covered = coveredCells(cache)
  const ring = pixels(
    {
      x: viewport.x - viewport.width / 2,
      y: viewport.y - viewport.height / 2,
      width: viewport.width * 2,
      height: viewport.height * 2
    },
    width,
    height
  )
  const first = (v: number): number => Math.max(0, Math.floor(v / CELL))
  const last = (v: number, size: number): number =>
    Math.min(Math.ceil(size / CELL), Math.ceil(v / CELL)) - 1
  const blocks = new Map<string, Rect>()
  for (let row = first(ring.y0); row <= last(ring.y1, height); ++row)
    for (let column = first(ring.x0); column <= last(ring.x1, width); ++column) {
      if (covered.has(`${column},${row}`)) continue
      const id = `${Math.floor((column * CELL) / BLOCK)},${Math.floor((row * CELL) / BLOCK)}`
      const cell = {
        x0: column * CELL,
        y0: row * CELL,
        x1: Math.min(width, (column + 1) * CELL),
        y1: Math.min(height, (row + 1) * CELL)
      }
      const block = blocks.get(id)
      blocks.set(
        id,
        block
          ? {
              x0: Math.min(block.x0, cell.x0),
              y0: Math.min(block.y0, cell.y0),
              x1: Math.max(block.x1, cell.x1),
              y1: Math.max(block.y1, cell.y1)
            }
          : cell
      )
    }
  const cx = (viewport.x + viewport.width / 2) * width
  const cy = (viewport.y + viewport.height / 2) * height
  const distance = (r: Rect): number => Math.hypot((r.x0 + r.x1) / 2 - cx, (r.y0 + r.y1) / 2 - cy)
  const best = [...blocks.values()]
    .map((r) => ({
      region: {
        x: (r.x0 + 0.25) / width,
        y: (r.y0 + 0.25) / height,
        width: (r.x1 - r.x0 - 0.5) / width,
        height: (r.y1 - r.y0 - 0.5) / height
      },
      distance: distance(r)
    }))
    .filter(({ region }) => !skip.has(JSON.stringify(region)))
    .sort((a, b) => a.distance - b.distance)[0]
  return best?.region ?? null
}
