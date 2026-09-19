// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { previewUrl } from '@shared/preview'
import { OrientedImage } from '../src/renderer/src/components/OrientedImage'

const file: X3FFileDTO = { id: 'a', path: '/photos/a.X3F', fileName: 'a.X3F' }
const context = { setTransform: vi.fn(), drawImage: vi.fn() }
const observe = vi.fn()
const disconnect = vi.fn()
let reveal: (visible: boolean) => void
const bitmap = () => ({ width: 640, height: 480, close: vi.fn() })
let decoded: ReturnType<typeof bitmap>

beforeEach(() => {
  decoded = bitmap()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, blob: async () => new Blob() }))
  )
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => decoded)
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = observe
      disconnect = disconnect
      constructor(callback: IntersectionObserverCallback) {
        reveal = (isIntersecting) =>
          callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
          )
      }
    }
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('image loading', () => {
  it('uses the real Radix Skeleton while metadata or pixels are pending and clears it on load/error', () => {
    vi.useFakeTimers()
    const view = render(<OrientedImage file={{ ...file, pending: true }} />)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    act(() => vi.advanceTimersByTime(999))
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    const skeleton = view.container.querySelector('.rt-Skeleton')
    expect(skeleton).not.toBeNull()
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true')
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByRole('img')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()

    view.rerender(<OrientedImage file={file} />)
    const image = screen.getByRole('img', { name: file.fileName })
    expect(image.getAttribute('loading')).toBe('lazy')
    expect(image.getAttribute('decoding')).toBe('async')
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    fireEvent.load(image)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')

    view.rerender(<OrientedImage file={{ ...file, path: '/photos/b.X3F', fileName: 'b.X3F' }} />)
    const next = screen.getByRole('img', { name: 'b.X3F' })
    expect(next).not.toBe(image)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('true')
    fireEvent.load(image) // A detached image cannot mark the new source ready.
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('true')
    act(() => vi.advanceTimersByTime(1000))
    expect(view.container.querySelector('.rt-Skeleton')).not.toBeNull()
    fireEvent.error(next)
    expect(screen.queryByRole('img', { name: 'b.X3F' })).toBeNull()
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(screen.getByRole('img', { name: 'No preview available' })).toBeTruthy()
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
  })

  it.each(['load', 'error'] as const)(
    'shows the small preview after one second and keeps it until the full JPEG reports %s',
    (event) => {
      vi.useFakeTimers()
      const onLoad = vi.fn()
      const view = render(
        <OrientedImage file={file} variant="full" loading="eager" onLoad={onLoad} />
      )
      const full = view.container.querySelector('img[aria-hidden="true"]')!
      expect(screen.queryByRole('img')).toBeNull()
      act(() => vi.advanceTimersByTime(999))
      expect(view.container.querySelector('img[src$="v=preview"]')).toBeNull()
      act(() => vi.advanceTimersByTime(1))
      const small = screen.getByRole('img', { name: file.fileName })
      expect(full.getAttribute('src')).toBe(previewUrl(file.path, 'full', file.id))
      expect(full.getAttribute('loading')).toBe('eager')
      expect(small.getAttribute('src')).toBe(previewUrl(file.path, 'preview', file.id))
      fireEvent.load(small)
      expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
      expect(screen.getByRole('img', { name: file.fileName })).toBe(small)
      expect(onLoad).not.toHaveBeenCalled()

      fireEvent[event](full)
      expect(screen.getByRole('img', { name: file.fileName })).toBe(event === 'load' ? full : small)
      expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
      expect(view.container.querySelector('.lucide-image-off')).toBeNull()
      expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
      expect(onLoad).toHaveBeenCalledTimes(event === 'load' ? 1 : 0)
    }
  )

  it('never mounts the small fallback when the full image loads within one second', () => {
    vi.useFakeTimers()
    const onLoad = vi.fn()
    const view = render(
      <OrientedImage file={file} variant="full" loading="eager" onLoad={onLoad} />
    )
    const full = view.container.querySelector('img')!
    expect(full.getAttribute('decoding')).toBe('sync')
    act(() => vi.advanceTimersByTime(100))
    fireEvent.load(full)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('img', { name: file.fileName })).toBe(full)
    expect(view.container.querySelectorAll('img')).toHaveLength(1)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(onLoad).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('resets the fallback delay when navigating to another pending full image', () => {
    vi.useFakeTimers()
    const view = render(<OrientedImage file={file} variant="full" />)
    act(() => vi.advanceTimersByTime(900))
    view.rerender(
      <OrientedImage file={{ ...file, id: 'next-full', path: '/photos/next.X3F' }} variant="full" />
    )
    act(() => vi.advanceTimersByTime(999))
    expect(view.container.querySelector('img[src$="v=preview"]')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(view.container.querySelector('img[src$="v=preview"]')?.getAttribute('src')).toContain(
      'next.X3F'
    )
  })

  it('loads the full JPEG before import metadata and keeps it ready when orientation/crop arrive', () => {
    const onLoad = vi.fn()
    const view = render(
      <OrientedImage
        file={{ ...file, pending: true }}
        variant="full"
        loading="eager"
        onLoad={onLoad}
      />
    )
    const full = view.container.querySelector('img')!
    expect(full.getAttribute('src')).toBe(previewUrl(file.path, 'full', file.id))
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    fireEvent.load(full)
    expect(screen.getByRole('img', { name: file.fileName })).toBe(full)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()

    view.rerender(
      <OrientedImage
        file={{ ...file, pending: false, orientation: 6, aspectRatio: 2 }}
        variant="full"
        loading="eager"
        onLoad={onLoad}
      />
    )
    expect(screen.getByRole('img', { name: file.fileName })).toBe(full)
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(view.container.querySelector('canvas')).toBeNull()
    expect(onLoad).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('waits for visibility before fetching a canvas preview, then rotates/crops and closes the bitmap', async () => {
    const oriented = { ...file, orientation: 6, aspectRatio: 2 }
    const view = render(<OrientedImage file={{ ...oriented, pending: true }} maxEdge={320} />)
    expect(observe).not.toHaveBeenCalled()
    view.rerender(<OrientedImage file={oriented} maxEdge={320} />)
    expect(observe).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    act(() => reveal(false))
    expect(fetch).not.toHaveBeenCalled()
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()

    act(() => reveal(true))
    await waitFor(() =>
      expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
    )
    const canvas = screen.getByRole('img', { name: file.fileName }) as HTMLCanvasElement
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(previewUrl(file.path, 'preview', file.id), {
      signal: expect.any(AbortSignal)
    })
    expect(context.drawImage).toHaveBeenCalledWith(decoded, 0, 80, 640, 320, 0, 0, 320, 160)
    expect(context.setTransform).toHaveBeenCalledWith(0, 1, -1, 0, 160, 0)
    expect([canvas.width, canvas.height]).toEqual([160, 320])
    expect(decoded.close).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalled()
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
  })

  it('aborts the old source on navigation and closes a stale decoded bitmap without painting it', async () => {
    let finish!: (value: ImageBitmap) => void
    vi.mocked(createImageBitmap).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<OrientedImage file={{ ...file, orientation: 6 }} loading="eager" />)
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1))
    const firstSignal = vi.mocked(fetch).mock.calls[0][1]!.signal!
    const nextFile = { ...file, path: '/photos/b.X3F', fileName: 'b.X3F', orientation: 6 }
    view.rerender(<OrientedImage file={nextFile} loading="eager" />)
    expect(firstSignal.aborted).toBe(true)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    await waitFor(() =>
      expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
    )
    const currentCanvas = screen.getByRole('img', { name: 'b.X3F' })
    const stale = bitmap()
    await act(async () => finish(stale as unknown as ImageBitmap))
    expect(stale.close).toHaveBeenCalledTimes(1)
    expect(decoded.close).toHaveBeenCalledTimes(1)
    expect(context.drawImage).toHaveBeenCalledTimes(1)
    expect(context.drawImage.mock.calls[0][0]).toBe(decoded)
    expect(screen.getByRole('img', { name: 'b.X3F' })).toBe(currentCanvas)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
  })

  it('closes the bitmap and clears its Skeleton when drawing fails', async () => {
    context.drawImage.mockImplementationOnce(() => {
      throw new Error('Draw failed')
    })
    const view = render(<OrientedImage file={{ ...file, orientation: 6 }} loading="eager" />)
    await waitFor(() =>
      expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
    )
    expect(decoded.close).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(screen.getByRole('img', { name: 'No preview available' })).toBeTruthy()
    expect(screen.queryByRole('img', { name: file.fileName })).toBeNull()
  })

  it('uses a browser-cached full image before paint, without showing the small fallback', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1600)
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(1200)
    const onLoad = vi.fn()
    const view = render(<OrientedImage file={file} variant="full" onLoad={onLoad} />)
    const full = screen.getByRole('img', { name: file.fileName })
    expect(full.getAttribute('src')).toBe(previewUrl(file.path, 'full', file.id))
    expect(full.classList.contains('opacity-100')).toBe(true)
    expect(view.container.querySelectorAll('img')).toHaveLength(1)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(onLoad).toHaveBeenCalledWith(full)
    fireEvent.load(full)
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it('reuses oriented pixels immediately on a revisit, but reloads a reimported file', async () => {
    const cachedFile = { ...file, id: 'canvas-revisit', orientation: 8 }
    const view = render(<OrientedImage file={cachedFile} loading="eager" />)
    await waitFor(() =>
      expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
    )
    const first = screen.getByRole('img') as HTMLCanvasElement
    view.rerender(<OrientedImage file={{ ...file, id: 'other', path: '/photos/other.X3F' }} />)
    view.rerender(
      <StrictMode>
        <OrientedImage file={cachedFile} loading="eager" />
      </StrictMode>
    )
    const second = screen.getByRole('img') as HTMLCanvasElement
    expect(second).not.toBe(first)
    expect([second.width, second.height]).toEqual([480, 640])
    expect(context.drawImage).toHaveBeenLastCalledWith(first, 0, 0)
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)

    view.rerender(<OrientedImage file={{ ...cachedFile, id: 'reimported' }} loading="eager" />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenLastCalledWith(previewUrl(file.path, 'preview', 'reimported'), {
      signal: expect.any(AbortSignal)
    })
  })
})
