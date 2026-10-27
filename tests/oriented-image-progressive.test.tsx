// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { X3FFileDTO } from '@shared/types'
import { displayPreviewUrl } from '@shared/preview'

const { cachedSmallPreview, loadSmallPreview, lookupSmallPreview } = vi.hoisted(() => ({
  cachedSmallPreview: vi.fn(),
  loadSmallPreview: vi.fn(),
  lookupSmallPreview: vi.fn()
}))
vi.mock('../src/renderer/src/lib/previewImages', () => ({
  cachedSmallPreview,
  loadSmallPreview,
  lookupSmallPreview
}))
import { OrientedImage } from '../src/renderer/src/components/OrientedImage'

type Deferred = { resolve: (canvas?: unknown) => void; reject: (error: unknown) => void }
let serial = 0
let loads: Map<string, Deferred>
let lookups: Map<string, Deferred>
let animate: ReturnType<typeof vi.fn>
let reduced = false
const source = (width = 640, height = 480) => ({ width, height }) as HTMLCanvasElement
const edited = (revision: number, file: X3FFileDTO): X3FFileDTO => ({
  ...file,
  edit: { revision, previewUrl: `x3f-edit://localhost/e?r=${revision}` } as X3FFileDTO['edit']
})
const editUrl = (file: X3FFileDTO): string => displayPreviewUrl(file)
const originalUrl = (file: X3FFileDTO): string => displayPreviewUrl({ ...file, edit: undefined })
const deferred = (map: Map<string, Deferred>, url: string) =>
  new Promise((resolve, reject) => map.set(url, { resolve, reject }))
const front = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLCanvasElement>('canvas[role="img"]')!
const layers = (view: ReturnType<typeof render>) => [...view.container.querySelectorAll('canvas')]
const busy = (view: ReturnType<typeof render>) =>
  view.container.firstElementChild!.getAttribute('aria-busy')

let base: X3FFileDTO
beforeEach(() => {
  base = {
    id: `p-${serial++}`,
    path: `/p/${serial}.X3F`,
    fileName: 'a.X3F',
    previewRevision: `r${serial}`,
    orientation: 6,
    aspectRatio: 1.5
  }
  loads = new Map()
  lookups = new Map()
  reduced = false
  cachedSmallPreview.mockReset().mockReturnValue(undefined)
  loadSmallPreview.mockReset().mockImplementation((url: string) => deferred(loads, url))
  lookupSmallPreview.mockReset().mockImplementation((url: string) => deferred(lookups, url))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D)
  animate = vi.fn(() => ({ cancel: vi.fn() }))
  HTMLCanvasElement.prototype.animate = animate as unknown as HTMLCanvasElement['animate']
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('shows the original after an edit miss, then fades to the edit and releases the original', async () => {
  const file = edited(1, base)
  const onReady = vi.fn()
  const view = render(<OrientedImage file={file} loading="eager" onReady={onReady} />)
  // Source orientation and crop for the original; none for the oriented edit.
  expect(loadSmallPreview).toHaveBeenCalledWith(
    originalUrl(file),
    6,
    1.5,
    expect.any(AbortSignal),
    'selected'
  )
  await act(async () => loads.get(originalUrl(file))!.resolve(source()))
  // The original waits for the edited lookup.
  expect(front(view).dataset.previewUrl).toBeUndefined()
  await act(async () => lookups.get(editUrl(file))!.resolve(undefined))
  expect(loadSmallPreview).toHaveBeenCalledWith(
    editUrl(file),
    1,
    undefined,
    expect.any(AbortSignal),
    'selected'
  )
  const fallback = front(view)
  expect(fallback.dataset.previewUrl).toBe(originalUrl(file))
  expect(busy(view)).toBe('true')
  expect(onReady).toHaveBeenCalledOnce()
  await act(async () => loads.get(editUrl(file))!.resolve(source(500, 400)))
  const shown = front(view)
  expect(shown).not.toBe(fallback)
  expect(shown.dataset.previewUrl).toBe(editUrl(file))
  // The edit fades in while the original fades out.
  expect(animate.mock.contexts).toEqual([shown, fallback])
  expect(animate.mock.calls[1]).toEqual([
    [{ opacity: 1 }, { opacity: 0 }],
    { duration: 180, fill: 'forwards' }
  ])
  expect(busy(view)).toBe('false')
  expect(fallback.getAttribute('aria-hidden')).toBe('true')
  expect(fallback.classList.contains('hidden')).toBe(false)
  await act(() => vi.advanceTimersByTimeAsync(180))
  expect(fallback.width).toBe(0)
  expect(fallback.dataset.previewUrl).toBeUndefined()
  expect(fallback.classList.contains('hidden')).toBe(true)
  expect(onReady).toHaveBeenCalledOnce()
})

it('paints a decoded edit before paint and never shows the original on a stored hit', async () => {
  const file = edited(1, base)
  cachedSmallPreview.mockImplementation((url: string) =>
    url === editUrl(file) ? source() : undefined
  )
  const view = render(<OrientedImage file={file} loading="eager" />)
  expect(front(view).dataset.previewUrl).toBe(editUrl(file))
  expect(loadSmallPreview).not.toHaveBeenCalled()

  cachedSmallPreview.mockReturnValue(undefined)
  const next = { ...edited(1, base), path: '/other.X3F' }
  view.rerender(<OrientedImage file={next} loading="eager" />)
  await act(async () => loads.get(originalUrl(next))!.resolve(source()))
  await act(async () => lookups.get(editUrl(next))!.resolve(source()))
  expect(front(view).dataset.previewUrl).toBe(editUrl(next))
  expect(layers(view).filter((canvas) => canvas.dataset.previewUrl)).toHaveLength(1)
  expect(loadSmallPreview).toHaveBeenCalledTimes(1)
  expect(animate).not.toHaveBeenCalled()
})

it('never replaces edited pixels with a late original', async () => {
  const file = edited(1, base)
  const view = render(<OrientedImage file={file} loading="eager" />)
  await act(async () => lookups.get(editUrl(file))!.resolve(undefined))
  await act(async () => loads.get(editUrl(file))!.resolve(source()))
  await act(async () => loads.get(originalUrl(file))!.resolve(source()))
  expect(front(view).dataset.previewUrl).toBe(editUrl(file))
  expect(animate).not.toHaveBeenCalled()
})

it('keeps the original when the edit fails and reports an error only without pixels', async () => {
  const file = edited(1, base)
  const view = render(<OrientedImage file={file} loading="eager" />)
  await act(async () => lookups.get(editUrl(file))!.resolve(undefined))
  await act(async () => loads.get(originalUrl(file))!.resolve(source()))
  await act(async () => loads.get(editUrl(file))!.reject(new Error('render')))
  expect(front(view).dataset.previewUrl).toBe(originalUrl(file))
  expect(view.queryByRole('img', { name: 'No preview available' })).toBeNull()
  expect(busy(view)).toBe('false')

  const other = { ...edited(1, base), path: '/fails.X3F' }
  view.rerender(<OrientedImage file={other} loading="eager" />)
  await act(async () => lookups.get(editUrl(other))!.resolve(undefined))
  await act(async () => loads.get(editUrl(other))!.reject(new Error('render')))
  await act(async () => loads.get(originalUrl(other))!.reject(new Error('extract')))
  expect(view.getByRole('img', { name: 'No preview available' })).toBeTruthy()
  expect(busy(view)).toBe('false')
})

it('keeps pixels across revisions and a reset, ignores stale results, and resets on a new source', async () => {
  const first = edited(1, base)
  cachedSmallPreview.mockImplementation((url: string) =>
    url === editUrl(first) ? source() : undefined
  )
  const view = render(<OrientedImage file={first} loading="eager" />)
  const shown = front(view)
  const second = edited(2, base)
  view.rerender(<OrientedImage file={second} loading="eager" />)
  expect(front(view)).toBe(shown)
  expect(shown.dataset.previewUrl).toBe(editUrl(first))
  const third = edited(3, base)
  view.rerender(<OrientedImage file={third} loading="eager" />)
  // A revision with shown pixels loads directly, without the original.
  expect(lookupSmallPreview).not.toHaveBeenCalled()
  await act(async () => loads.get(editUrl(second))!.resolve(source()))
  expect(front(view).dataset.previewUrl).toBe(editUrl(first))
  await act(async () => loads.get(editUrl(third))!.resolve(source()))
  expect(front(view).dataset.previewUrl).toBe(editUrl(third))
  await act(() => vi.advanceTimersByTimeAsync(180))

  view.rerender(<OrientedImage file={base} loading="eager" />)
  expect(front(view).dataset.previewUrl).toBe(editUrl(third))
  await act(async () => loads.get(originalUrl(base))!.resolve(source()))
  expect(front(view).dataset.previewUrl).toBe(originalUrl(base))

  // A failed reset keeps the old edit, but does not leave the image busy.
  view.rerender(<OrientedImage file={first} loading="eager" />)
  view.rerender(<OrientedImage file={base} loading="eager" />)
  await act(async () => loads.get(originalUrl(base))!.reject(new Error('extract')))
  expect(front(view).dataset.previewUrl).toBe(editUrl(first))
  expect(busy(view)).toBe('false')
  expect(view.queryByRole('img', { name: 'No preview available' })).toBeNull()

  const changed = { ...base, previewRevision: 'changed' }
  view.rerender(<OrientedImage file={changed} loading="eager" />)
  expect(front(view).dataset.previewUrl).toBeUndefined()
  expect(busy(view)).toBe('true')
})

it('swaps at once with reduced motion', async () => {
  reduced = true
  const file = edited(1, base)
  const view = render(<OrientedImage file={file} loading="eager" />)
  await act(async () => lookups.get(editUrl(file))!.resolve(undefined))
  await act(async () => loads.get(originalUrl(file))!.resolve(source()))
  const fallback = front(view)
  await act(async () => loads.get(editUrl(file))!.resolve(source()))
  expect(animate).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(fallback.width).toBe(0)
  expect(fallback.classList.contains('hidden')).toBe(true)
})

it('looks up the edit again on a revisit before it shows a cached original', async () => {
  const file = edited(1, base)
  const view = render(<OrientedImage file={file} loading="eager" />)
  await act(async () => lookups.get(editUrl(file))!.resolve(undefined))
  view.unmount()
  cachedSmallPreview.mockImplementation((url: string) =>
    url === originalUrl(file) ? source() : undefined
  )
  const again = render(<OrientedImage file={file} loading="eager" />)
  expect(front(again).dataset.previewUrl).toBeUndefined()
  // A full preview render stored the thumbnail meanwhile.
  await act(async () => lookups.get(editUrl(file))!.resolve(source()))
  expect(front(again).dataset.previewUrl).toBe(editUrl(file))
  expect(animate).not.toHaveBeenCalled()
})

it('shows only exact pixels without progressive loading, and only looks up without render', async () => {
  const file = edited(1, base)
  const view = render(<OrientedImage file={file} loading="eager" progressive={false} />)
  expect(lookupSmallPreview).not.toHaveBeenCalled()
  expect(loadSmallPreview).toHaveBeenCalledTimes(1)
  expect(loadSmallPreview.mock.calls[0][0]).toBe(editUrl(file))
  // Each edit URL starts again, so no older edit stays under the minimap.
  await act(async () => loads.get(editUrl(file))!.resolve(source()))
  const shown = front(view)
  view.rerender(<OrientedImage file={edited(2, base)} loading="eager" progressive={false} />)
  expect(front(view)).not.toBe(shown)
  expect(front(view).dataset.previewUrl).toBeUndefined()

  cleanup()
  loadSmallPreview.mockClear()
  const other = { ...edited(1, base), path: '/lookup.X3F' }
  const lookupOnly = render(<OrientedImage file={other} loading="eager" render={false} />)
  await act(async () => lookups.get(editUrl(other))!.resolve(undefined))
  await act(async () => loads.get(originalUrl(other))!.resolve(source()))
  expect(loadSmallPreview).toHaveBeenCalledTimes(1)
  expect(front(lookupOnly).dataset.previewUrl).toBe(originalUrl(other))
})
