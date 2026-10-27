// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { FilmstripImage } from '../src/renderer/src/components/FilmstripImage'
import { ZoomablePreview } from '../src/renderer/src/components/ZoomablePreview'
import type { X3FFileDTO } from '@shared/types'
import { displayPreviewUrl } from '@shared/preview'

const { fitSubscribe, fullSubscribe, smallReady } = vi.hoisted(() => ({
  fitSubscribe: vi.fn(),
  fullSubscribe: vi.fn(),
  smallReady: { current: undefined as (() => void) | undefined }
}))
vi.mock('../src/renderer/src/lib/fitPreviews', () => ({ subscribeFitPreview: fitSubscribe }))
vi.mock('../src/renderer/src/lib/previewImages', () => ({ subscribeFullPreview: fullSubscribe }))
vi.mock('../src/renderer/src/components/OrientedImage', () => ({
  OrientedImage: ({
    loadingDelay,
    render,
    onReady
  }: {
    loadingDelay?: number
    render?: boolean
    onReady?: () => void
  }) => {
    smallReady.current = onReady
    return <div data-small-preview data-loading-delay={loadingDelay} data-render={String(render)} />
  }
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
  delete (Element.prototype as Partial<Element>).animate
  vi.unstubAllGlobals()
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
  expect(dimensions).toHaveBeenCalledWith({ width: 6000, height: 4000 }, url)
  expect(fullSubscribe).not.toHaveBeenCalled()
  expect(view.container.querySelector('[data-small-preview]')).toBeNull()
  expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
})

it('shows the stored or embedded small fallback while a slow edited Fit renders, without its geometry', async () => {
  vi.useFakeTimers()
  const pending: Array<(preview: typeof fit) => void> = []
  fitSubscribe.mockImplementation((_url, ready) => {
    pending.push(ready)
    return () => {}
  })
  const url = 'x3f-edit://localhost/slow'
  const dimensions = vi.fn()
  const view = render(
    <FilmstripImage file={{ ...file, displayPreviewUrl: url }} onDimensions={dimensions} />
  )
  const small = view.container.querySelector('[data-small-preview]')!
  expect(small.getAttribute('data-render')).toBe('false')
  expect(small.getAttribute('data-loading-delay')).toBe('500')
  act(() => smallReady.current?.())
  expect(dimensions).not.toHaveBeenCalled()
  const canvas = view.container.querySelector('canvas')!
  expect(canvas.classList.contains('opacity-0')).toBe(true)
  const cancel = vi.fn()
  const animate = vi.fn(() => ({ cancel }))
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
  act(() => pending[0](fit))
  // Both layers crossfade, so that a different crop does not cut the fallback edges.
  expect(animate.mock.contexts).toEqual([canvas, small.parentElement])
  expect(animate.mock.calls.map(([frames]) => frames)).toEqual([
    [{ opacity: 0 }, { opacity: 1 }],
    [{ opacity: 1 }, { opacity: 0 }]
  ])
  expect(animate.mock.calls[1][1]).toEqual({ duration: 180, fill: 'forwards' })
  expect(dimensions).toHaveBeenCalledOnce()
  expect(dimensions).toHaveBeenCalledWith({ width: 6000, height: 4000 }, url)
  expect(canvas.classList.contains('opacity-100')).toBe(true)
  // The fallback stays under the Fit image while it fades in.
  expect(view.container.querySelector('[data-small-preview]')).not.toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(180))
  expect(view.container.querySelector('[data-small-preview]')).toBeNull()
  expect(cancel).toHaveBeenCalledTimes(2)
  delete (Element.prototype as Partial<Element>).animate
})

it('does not fade a Fit image over a fallback that showed no pixels', () => {
  let ready!: (preview: typeof fit) => void
  fitSubscribe.mockImplementation((_url, next) => {
    ready = next
    return () => {}
  })
  const view = render(<FilmstripImage file={{ ...file, displayPreviewUrl: 'x3f-edit://a' }} />)
  act(() => ready(fit))
  expect(view.container.querySelector('[data-small-preview]')).toBeNull()
})

it('keeps live edit frames opaque across rapid slider updates', () => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }))
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
  const pending: Array<(preview: typeof fit) => void> = []
  fitSubscribe.mockImplementation((_url, ready) => {
    pending.push(ready)
    return () => {}
  })
  const edited = (revision: number) => ({
    ...file,
    displayPreviewUrl: `x3f-edit://frame-${revision}`
  })
  const view = render(<FilmstripImage file={edited(0)} />)
  act(() => pending[0](fit))
  const canvas = view.container.querySelector('canvas')!
  for (let revision = 1; revision <= 3; revision++) {
    view.rerender(<FilmstripImage file={edited(revision)} />)
    expect(canvas.dataset.previewUrl).toBe(edited(revision - 1).displayPreviewUrl)
    act(() => pending[revision](fit))
    expect(view.container.querySelector('canvas')).toBe(canvas)
    expect(canvas.dataset.previewUrl).toBe(edited(revision).displayPreviewUrl)
    expect(canvas.classList.contains('opacity-100')).toBe(true)
  }
  expect(animate).not.toHaveBeenCalled()
  expect(view.container.querySelector('[data-small-preview]')).toBeNull()
})

it('ends the initial thumbnail fade when a newer edit frame arrives', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const animate = vi.fn(() => ({ cancel }))
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate })
  const pending: Array<(preview: typeof fit) => void> = []
  fitSubscribe.mockImplementation((_url, ready) => {
    pending.push(ready)
    return () => {}
  })
  const view = render(<FilmstripImage file={{ ...file, displayPreviewUrl: 'x3f-edit://first' }} />)
  const fallback = view.container.querySelector('[data-small-preview]')!.parentElement!
  act(() => smallReady.current?.())
  act(() => pending[0](fit))
  expect(animate).toHaveBeenCalledTimes(2)
  await act(() => vi.advanceTimersByTimeAsync(60))
  view.rerender(<FilmstripImage file={{ ...file, displayPreviewUrl: 'x3f-edit://next' }} />)
  act(() => pending[1](fit))
  expect(cancel).toHaveBeenCalledTimes(2)
  expect(animate).toHaveBeenCalledTimes(2)
  expect(view.container.querySelector('[data-small-preview]')).toBeNull()
  expect(fallback.style.opacity).toBe('0')
  const canvas = view.container.querySelector('canvas')!
  expect(canvas.dataset.previewUrl).toBe('x3f-edit://next')
  await act(() => vi.advanceTimersByTimeAsync(180))
  expect(canvas.dataset.previewUrl).toBe('x3f-edit://next')
  expect(canvas.classList.contains('opacity-100')).toBe(true)
})

it('keeps same-photo pixels through a first save, edits and a reset', () => {
  const pending = new Map<string, (preview: typeof fit) => void>()
  fitSubscribe.mockImplementation((url: string, ready) => {
    // The original is a decoded cache hit; edits render later.
    if (url.startsWith('x3f-preview')) ready(fit)
    else pending.set(url, ready)
    return () => {}
  })
  const dimensions = vi.fn()
  const view = render(<FilmstripImage file={file} onDimensions={dimensions} />)
  const canvas = view.container.querySelector('canvas')!
  const originalUrl = displayPreviewUrl(file, 'full')
  expect(canvas.dataset.previewUrl).toBe(originalUrl)
  const edit = (url: string): X3FFileDTO => ({ ...file, displayPreviewUrl: url })

  view.rerender(<FilmstripImage file={edit('x3f-edit://a')} onDimensions={dimensions} />)
  expect(view.container.querySelector('canvas')).toBe(canvas)
  expect(canvas.dataset.previewUrl).toBe(originalUrl)
  expect(canvas.hasAttribute('data-rendered-preview')).toBe(true)
  expect(view.container.querySelector('[data-small-preview]')).toBeNull()
  expect(view.container.firstElementChild!.getAttribute('aria-busy')).toBe('true')
  act(() => pending.get('x3f-edit://a')!({ ...fit, width: 3000 }))
  expect(canvas.dataset.previewUrl).toBe('x3f-edit://a')
  expect(dimensions).toHaveBeenLastCalledWith({ width: 3000, height: 4000 }, 'x3f-edit://a')
  expect(view.container.querySelectorAll('canvas')).toHaveLength(1)

  // A later edit never shows the original between edits.
  view.rerender(<FilmstripImage file={edit('x3f-edit://b')} onDimensions={dimensions} />)
  expect(canvas.dataset.previewUrl).toBe('x3f-edit://a')
  expect(view.container.querySelector('[data-small-preview]')).toBeNull()

  view.rerender(<FilmstripImage file={file} onDimensions={dimensions} />)
  expect(view.container.querySelector('canvas')).toBe(canvas)
  expect(canvas.dataset.previewUrl).toBe(originalUrl)
  expect(canvas.hasAttribute('data-rendered-preview')).toBe(false)
  expect(dimensions).toHaveBeenCalledTimes(3)
})

it('swaps the thumbnail immediately under reduced motion', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const pending: Array<(preview: typeof fit) => void> = []
  fitSubscribe.mockImplementation((_url, ready) => {
    pending.push(ready)
    return () => {}
  })
  const view = render(<FilmstripImage file={{ ...file, displayPreviewUrl: 'x3f-edit://a' }} />)
  act(() => smallReady.current?.())
  act(() => pending[0](fit))
  expect(view.container.querySelector('[data-small-preview]')).toBeNull()
  view.rerender(<FilmstripImage file={{ ...file, displayPreviewUrl: 'x3f-edit://b' }} />)
  act(() => pending[1](fit))
  expect(view.container.querySelectorAll('canvas')).toHaveLength(1)
})

it('keeps previous pixels or the fallback on errors and starts again for a new source', () => {
  const calls: Array<{ ready: (preview: typeof fit) => void; error: () => void }> = []
  fitSubscribe.mockImplementation((_url, ready, error) => {
    calls.push({ ready, error })
    return () => {}
  })
  const edited = { ...file, displayPreviewUrl: 'x3f-edit://a' }
  const view = render(<FilmstripImage file={edited} />)
  expect(view.container.firstElementChild!.getAttribute('aria-busy')).toBe('true')
  act(() => calls[0].error())
  // The valid fallback stays; it shows its own error if it has no pixels.
  expect(view.container.querySelector('[data-small-preview]')).not.toBeNull()
  expect(view.container.firstElementChild!.getAttribute('aria-busy')).toBe('false')
  view.rerender(<FilmstripImage file={{ ...edited, displayPreviewUrl: 'x3f-edit://b' }} />)
  act(() => calls[1].ready(fit))
  const canvas = view.container.querySelector('canvas')!
  view.rerender(<FilmstripImage file={{ ...edited, displayPreviewUrl: 'x3f-edit://c' }} />)
  act(() => calls[2].error())
  expect(canvas.dataset.previewUrl).toBe('x3f-edit://b')
  expect(canvas.classList.contains('opacity-100')).toBe(true)

  view.rerender(
    <FilmstripImage
      file={{ ...edited, displayPreviewUrl: 'x3f-edit://c', previewRevision: 'r2' }}
    />
  )
  const fresh = view.container.querySelector('canvas')!
  expect(fresh).not.toBe(canvas)
  expect(fresh.classList.contains('opacity-0')).toBe(true)
  expect(view.container.querySelector('[data-small-preview]')).not.toBeNull()
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
  expect(onDimensions).toHaveBeenCalledWith(
    { width: 6000, height: 4000 },
    displayPreviewUrl(file, 'full')
  )
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

it('tells the zoomable editor preview which frame painted, only after the frame decodes', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  const decoding: Array<(preview: typeof fit) => void> = []
  fitSubscribe.mockImplementation((_url, ready) => {
    decoding.push(ready)
    return () => {}
  })
  const onPaint = vi.fn()
  const portrait = { ...file, displayPreviewUrl: 'x3f-edit://localhost/portrait' }
  const view = render(<ZoomablePreview file={portrait} onPaint={onPaint} />)
  act(() => decoding[0](fit))
  expect(onPaint).toHaveBeenLastCalledWith(portrait.displayPreviewUrl, expect.any(Object))
  // The render of an undone rotation arrives. Its frame decodes later, and the
  // portrait frame stays on the canvas until then.
  const landscape = { ...portrait, displayPreviewUrl: 'x3f-edit://localhost/landscape' }
  view.rerender(<ZoomablePreview file={landscape} onPaint={onPaint} />)
  const canvas = view.container.querySelector<HTMLCanvasElement>('[data-rendered-preview]')!
  expect(canvas.dataset.previewUrl).toBe(portrait.displayPreviewUrl)
  expect(onPaint).toHaveBeenCalledOnce()
  act(() => decoding[1](fit))
  expect(canvas.dataset.previewUrl).toBe(landscape.displayPreviewUrl)
  expect(onPaint).toHaveBeenLastCalledWith(landscape.displayPreviewUrl, expect.any(Object))
})
