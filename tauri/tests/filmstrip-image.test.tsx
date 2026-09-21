// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { FilmstripImage } from '../src/renderer/src/components/FilmstripImage'
import type { X3FFileDTO } from '@shared/types'

const { fitSubscribe, fullSubscribe } = vi.hoisted(() => ({
  fitSubscribe: vi.fn(),
  fullSubscribe: vi.fn()
}))
vi.mock('../src/renderer/src/lib/fitPreviews', () => ({ subscribeFitPreview: fitSubscribe }))
vi.mock('../src/renderer/src/lib/previewImages', () => ({ subscribeFullPreview: fullSubscribe }))
vi.mock('../src/renderer/src/components/OrientedImage', () => ({
  OrientedImage: ({ loadingDelay }: { loadingDelay?: number }) => (
    <div data-small-preview data-loading-delay={loadingDelay} />
  )
}))

const file: X3FFileDTO = { id: 'fit-a', path: '/a.X3F', fileName: 'a.X3F' }
const fit = { image: { width: 2048, height: 1365 }, width: 6000, height: 4000 }
const drawImage = vi.fn()
let complete: Array<() => void>
beforeEach(() => {
  complete = []
  fitSubscribe.mockReset().mockImplementation((_url, ready) => {
    ready(fit)
    return () => {}
  })
  fullSubscribe.mockReset().mockImplementation((source, ready) => {
    ready(`blob:${source}`)
    return () => {}
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage
  } as unknown as CanvasRenderingContext2D)
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: vi.fn(() => new Promise<void>((resolve) => complete.push(resolve)))
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

it('paints prefetched edited pixels immediately and keeps the original render URL', () => {
  const url = 'x3f-edit://localhost/edited-a'
  const dimensions = vi.fn()
  const view = render(
    <FilmstripImage file={{ ...file, displayPreviewUrl: url }} onDimensions={dimensions} />
  )
  const canvas = view.container.querySelector('canvas')!
  expect(canvas.dataset.previewUrl).toBe(url)
  expect(canvas.classList.contains('opacity-100')).toBe(true)
  expect(fitSubscribe).toHaveBeenCalledWith(url, expect.any(Function), expect.any(Function))
  expect(drawImage).toHaveBeenCalledWith(fit.image, 0, 0)
  expect(dimensions).toHaveBeenCalledWith({ width: 6000, height: 4000 })
  expect(fullSubscribe).not.toHaveBeenCalled()
  expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
})

it('shows an edited skeleton only after 500ms and keeps visible pixels throughout slower upgrades', async () => {
  vi.useFakeTimers()
  const pending: Array<(preview: typeof fit) => void> = []
  const releases: Array<ReturnType<typeof vi.fn>> = []
  fitSubscribe.mockImplementation((_url, ready) => {
    pending.push(ready)
    const release = vi.fn()
    releases.push(release)
    return release
  })
  const original = { ...file, displayPreviewUrl: 'x3f-edit://localhost/edited-a' }
  const view = render(<FilmstripImage file={original} />)
  await act(() => vi.advanceTimersByTimeAsync(499))
  expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(view.container.querySelector('.rt-Skeleton')).not.toBeNull()
  act(() => pending[0](fit))
  const canvas = view.container.querySelector('canvas')!
  expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
  view.rerender(
    <FilmstripImage file={{ ...original, displayPreviewUrl: 'x3f-edit://localhost/edited-b' }} />
  )
  expect(releases[0]).toHaveBeenCalledOnce()
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
  expect(view.container.querySelector('canvas')).toBe(canvas)
  expect(canvas.dataset.previewUrl).toBe(original.displayPreviewUrl)
  act(() => pending[1](fit))
  expect(canvas.dataset.previewUrl).toBe('x3f-edit://localhost/edited-b')
  view.unmount()
  expect(releases[1]).toHaveBeenCalledOnce()
})

it('resets the edited loading delay on URL/photo changes and ends it on errors', async () => {
  vi.useFakeTimers()
  const failures: Array<() => void> = []
  fitSubscribe.mockImplementation((_url, _ready, error) => {
    failures.push(error)
    return () => {}
  })
  const original = { ...file, displayPreviewUrl: 'x3f-edit://localhost/cold-a' }
  const view = render(<FilmstripImage file={original} />)
  await act(() => vi.advanceTimersByTimeAsync(400))
  view.rerender(
    <FilmstripImage file={{ ...original, displayPreviewUrl: 'x3f-edit://localhost/cold-b' }} />
  )
  await act(() => vi.advanceTimersByTimeAsync(499))
  expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(view.container.querySelector('.rt-Skeleton')).not.toBeNull()
  act(() => failures[1]())
  expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull()
  view.rerender(
    <FilmstripImage file={{ ...original, displayPreviewUrl: 'x3f-edit://localhost/cold-c' }} />
  )
  expect(view.container.querySelector('[role="alert"]')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(view.container.querySelector('.rt-Skeleton')).not.toBeNull()
  view.rerender(
    <FilmstripImage file={{ ...original, displayPreviewUrl: 'x3f-edit://localhost/cold-b' }} />
  )
  expect(view.container.querySelector('[role="alert"]')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(499))
  expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(view.container.querySelector('.rt-Skeleton')).not.toBeNull()
  view.rerender(<FilmstripImage file={{ ...original, id: 'other', path: '/other.X3F' }} />)
  await act(() => vi.advanceTimersByTimeAsync(499))
  expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(view.container.querySelector('.rt-Skeleton')).not.toBeNull()
})

it('uses the 500ms loading delay on the unedited fallback without covering it during Fit preparation', () => {
  fitSubscribe.mockImplementation(() => () => {})
  const view = render(<FilmstripImage file={file} />)
  expect(
    view.container.querySelector('[data-small-preview]')?.getAttribute('data-loading-delay')
  ).toBe('500')
  expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
})

it('paints a decoded 2K Fit cache hit before paint, using original geometry without mounting the full JPEG', () => {
  const onDimensions = vi.fn()
  const view = render(<FilmstripImage file={file} onDimensions={onDimensions} />)
  const canvas = view.container.querySelector('canvas')!
  expect([canvas.width, canvas.height]).toEqual([2048, 1365])
  expect(canvas.classList.contains('opacity-100')).toBe(true)
  expect(drawImage).toHaveBeenCalledWith(fit.image, 0, 0)
  expect(onDimensions).toHaveBeenCalledWith({ width: 6000, height: 4000 })
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.querySelector('[data-small-preview]')).toBeNull()
  expect(fullSubscribe).not.toHaveBeenCalled()
})

it('keeps exactly the same Fit pixels under the overlay until decode finishes, including rezoom', async () => {
  const dimensions = vi.fn()
  const view = render(<FilmstripImage file={file} onDimensions={dimensions} />)
  const medium = view.container.querySelector('canvas')!
  view.rerender(<FilmstripImage file={file} fullResolution onDimensions={dimensions} />)
  const full = view.container.querySelector('img')!
  expect(full.classList.contains('opacity-0')).toBe(true)
  fireEvent.load(full)
  expect(full.classList.contains('opacity-0')).toBe(true)
  expect(medium.isConnected && medium.classList.contains('opacity-100')).toBe(true)
  await act(async () => complete[0]())
  expect(full.classList.contains('opacity-100')).toBe(true)
  expect(view.container.querySelector('canvas')).toBe(medium)
  expect(dimensions).toHaveBeenCalledTimes(1)
  expect(drawImage).toHaveBeenCalledTimes(1)

  view.rerender(<FilmstripImage file={file} onDimensions={dimensions} />)
  expect(view.container.querySelector('img')).toBeNull()
  view.rerender(<FilmstripImage file={file} fullResolution onDimensions={dimensions} />)
  const next = view.container.querySelector('img')!
  expect(next).not.toBe(full)
  expect(next.classList.contains('opacity-0')).toBe(true)
  expect(view.container.querySelector('canvas')).toBe(medium)
  await act(async () => complete[1]())
  expect(next.classList.contains('opacity-100')).toBe(true)
})

it('retains the medium image through failed full decode and transport delays', async () => {
  let provide!: (url: string) => void
  fullSubscribe.mockImplementation((_source, ready) => {
    provide = ready
    return () => {}
  })
  vi.mocked(HTMLImageElement.prototype.decode).mockRejectedValue(new Error('decode failed'))
  const view = render(<FilmstripImage file={file} fullResolution />)
  const medium = view.container.querySelector('canvas')!
  expect(view.container.querySelector('img')).toBeNull()
  await act(async () => provide('blob:full'))
  expect(view.container.querySelector('img')?.classList.contains('opacity-0')).toBe(true)
  expect(view.container.querySelector('canvas')).toBe(medium)
  expect(medium.classList.contains('opacity-100')).toBe(true)
})

it('ignores a previous file’s completed decode and preserves geometry when import metadata arrives', async () => {
  const dimensions = vi.fn()
  const view = render(<FilmstripImage file={file} fullResolution onDimensions={dimensions} />)
  const stale = view.container.querySelector('img')!
  const next = { ...file, id: 'fit-b', path: '/b.X3F', fileName: 'b.X3F' }
  view.rerender(<FilmstripImage file={next} fullResolution onDimensions={dimensions} />)
  const current = view.container.querySelector('img')!
  await act(async () => complete[0]())
  expect(current.classList.contains('opacity-0')).toBe(true)
  expect(stale.isConnected).toBe(false)
  await act(async () => complete[1]())
  await waitFor(() => expect(current.classList.contains('opacity-100')).toBe(true))
  const medium = view.container.querySelector('canvas')!
  view.rerender(
    <FilmstripImage
      file={{ ...next, orientation: 6, aspectRatio: 2, pending: false }}
      fullResolution
      onDimensions={dimensions}
    />
  )
  expect(view.container.querySelector('canvas')).toBe(medium)
  expect(view.container.querySelector('img')).toBe(current)
  expect(dimensions).toHaveBeenCalledTimes(2)
})
