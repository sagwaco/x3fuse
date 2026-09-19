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
  OrientedImage: () => <div data-small-preview />
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
