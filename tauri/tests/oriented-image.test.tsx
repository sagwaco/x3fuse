// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { OrientedImage } from '../src/renderer/src/components/OrientedImage'
import { previewUrl } from '@shared/preview'

let serial = 0
let file: X3FFileDTO
const context = { setTransform: vi.fn(), drawImage: vi.fn() }
let reveal: () => void
beforeEach(() => {
  file = { id: `image-${serial++}`, path: '/photos/a.X3F', fileName: 'a.X3F' }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, blob: async () => new Blob(['jpeg']) }))
  )
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() }))
  )
  URL.createObjectURL = vi.fn(() => `blob:preview-${serial++}`)
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        reveal = () =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
          )
      }
      observe() {}
      disconnect() {}
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

it('keeps pending metadata unloaded and starts small decoding only when visible', async () => {
  const view = render(<OrientedImage file={{ ...file, pending: true }} />)
  expect(fetch).not.toHaveBeenCalled()
  expect(screen.queryByRole('img')).toBeNull()
  view.rerender(<OrientedImage file={{ ...file, orientation: 6, aspectRatio: 2 }} maxEdge={320} />)
  expect(fetch).not.toHaveBeenCalled()
  act(reveal)
  await waitFor(() =>
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
  )
  const canvas = screen.getByRole('img') as HTMLCanvasElement
  expect([canvas.width, canvas.height]).toEqual([160, 320])
  expect(fetch).toHaveBeenCalledWith(previewUrl(file.path, 'preview', file.id))
  expect(context.setTransform).toHaveBeenCalledWith(0, 1, -1, 0, 320, 0)
})

it('shares completed oriented pixels before paint on revisit and reloads reimports', async () => {
  const oriented = { ...file, orientation: 8 }
  const view = render(<OrientedImage file={oriented} loading="eager" />)
  await waitFor(() =>
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
  )
  view.rerender(<div />)
  view.rerender(
    <StrictMode>
      <OrientedImage file={oriented} loading="eager" />
    </StrictMode>
  )
  expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
  expect(fetch).toHaveBeenCalledTimes(1)
  view.rerender(<OrientedImage file={{ ...oriented, id: 'reimport-image' }} loading="eager" />)
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  await waitFor(() =>
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('false')
  )
})

it('reports unavailable previews without leaking a failed bitmap', async () => {
  const close = vi.fn()
  vi.mocked(createImageBitmap).mockResolvedValue({
    width: 640,
    height: 480,
    close
  } as unknown as ImageBitmap)
  context.drawImage.mockImplementationOnce(() => {
    throw new Error('draw')
  })
  render(<OrientedImage file={file} loading="eager" />)
  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'No preview available' })).toBeTruthy()
  )
  expect(close).toHaveBeenCalledTimes(1)
})
