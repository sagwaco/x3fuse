// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  cachedFullPreview,
  loadSmallPreview,
  subscribeFullPreview,
  subscribeFullPreviewBlob
} from '../src/renderer/src/lib/previewImages'

let serial = 0
const response = (size = 10) => ({ ok: true, blob: async () => ({ size }) })
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response())
  )
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 640, height: 480, close: vi.fn() }))
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(),
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D)
  URL.createObjectURL = vi.fn(() => `blob:test-${serial++}`)
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('runs only the first and latest full requests during twenty rapid selections', async () => {
  let finish!: (result: ReturnType<typeof response>) => void
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      })
  )
  const selected = vi.fn()
  let release = subscribeFullPreview('rapid-0', selected, vi.fn())
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  for (let i = 1; i <= 20; i++) {
    release()
    release = subscribeFullPreview(`rapid-${i}`, selected, vi.fn())
  }
  expect(fetch).toHaveBeenCalledTimes(1)
  finish(response())
  await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(1))
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['rapid-0', 'rapid-20'])
  release()
  const revisit = vi.fn()
  const off = subscribeFullPreview('rapid-0', revisit, vi.fn())
  expect(revisit).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  off()
})

it('prioritizes foreground after cancelled background preparation and releases evicted object URLs', async () => {
  let finish!: (result: ReturnType<typeof response>) => void
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      })
  )
  const cancel = subscribeFullPreview('neighbor-a', vi.fn(), vi.fn(), 'background')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  cancel()
  const selected = vi.fn()
  const release = subscribeFullPreview('foreground', selected, vi.fn())
  finish(response(65 * 1024 * 1024))
  await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(1))
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['neighbor-a', 'foreground'])
  expect(URL.revokeObjectURL).toHaveBeenCalled()
  expect(cachedFullPreview('neighbor-a')).toBeUndefined()
  expect(cachedFullPreview('foreground')).toBeDefined()
  release()
  cancel()
})

it('releases a full preview subscription only once so repeated cancellation cannot pin an evicted URL', async () => {
  vi.mocked(fetch).mockResolvedValue(response(40 * 1024 * 1024) as Response)
  const first = vi.fn()
  const release = subscribeFullPreview('release-once', first, vi.fn())
  await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())
  const oldUrl = first.mock.calls[0][0]
  release()
  release()
  const next = vi.fn()
  const releaseNext = subscribeFullPreview('release-pressure', next, vi.fn())
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
  expect(cachedFullPreview('release-once')).toBeUndefined()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldUrl)
  releaseNext()
})

it('deduplicates small decoding and does not cancel another consumer when one leaves', async () => {
  const first = new AbortController()
  const second = new AbortController()
  const a = loadSmallPreview('small-shared', 6, 2, first.signal).catch((error) => error.name)
  const b = loadSmallPreview('small-shared', 6, 2, second.signal)
  first.abort()
  expect(await a).toBe('AbortError')
  const canvas = await b
  expect([canvas.width, canvas.height]).toEqual([320, 640])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(createImageBitmap).toHaveBeenCalledTimes(1)
  expect(await loadSmallPreview('small-shared', 6, 2, second.signal)).toBe(canvas)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('drops small requests whose consumers disappear before extraction starts', async () => {
  const abort = new AbortController()
  const result = loadSmallPreview('small-abandoned', 1, undefined, abort.signal).catch(
    (error) => error.name
  )
  abort.abort()
  expect(await result).toBe('AbortError')
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps cached full URLs alive across viewer handoff while pinned images exceed the budget', async () => {
  vi.mocked(fetch).mockResolvedValue(response(40 * 1024 * 1024) as Response)
  const first = vi.fn()
  const second = vi.fn()
  const releaseA = subscribeFullPreview('handoff-a', first, vi.fn())
  await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())
  const releaseB = subscribeFullPreview('handoff-b', second, vi.fn())
  await vi.waitFor(() => expect(second).toHaveBeenCalledOnce())
  const source = cachedFullPreview('handoff-a')
  releaseA()
  const next = vi.fn()
  const releaseNext = subscribeFullPreview('handoff-a', next, vi.fn())
  await Promise.resolve()
  expect(next).toHaveBeenCalledWith(source)
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(source)
  expect(fetch).toHaveBeenCalledTimes(2)
  releaseNext()
  releaseB()
  await Promise.resolve()
})

it('never lets fit background preparation replace a pending foreground full request', async () => {
  let finish!: (result: ReturnType<typeof response>) => void
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      })
  )
  const first = vi.fn(),
    foreground = vi.fn(),
    background = vi.fn()
  const releaseFirst = subscribeFullPreview('priority-running', first, vi.fn())
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  const releaseForeground = subscribeFullPreview('priority-foreground', foreground, vi.fn())
  const releaseBackground = subscribeFullPreviewBlob(
    'priority-background',
    background,
    vi.fn(),
    'background'
  )
  finish(response())
  await vi.waitFor(() => expect(background).toHaveBeenCalledOnce())
  expect(vi.mocked(fetch).mock.calls.map(([source]) => source)).toEqual([
    'priority-running',
    'priority-foreground',
    'priority-background'
  ])
  expect(foreground).toHaveBeenCalledOnce()
  expect(background.mock.calls[0][0]).toMatchObject({ size: 10 })
  releaseFirst()
  releaseForeground()
  releaseBackground()
})

it('drops cancelled background preparation without releasing the running extraction slot', async () => {
  let finish!: (result: ReturnType<typeof response>) => void
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      })
  )
  const release = subscribeFullPreview('background-slot-running', vi.fn(), vi.fn(), 'background')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  release()
  const cancelQueued = subscribeFullPreview(
    'background-slot-cancelled',
    vi.fn(),
    vi.fn(),
    'background'
  )
  cancelQueued()
  const ready = vi.fn()
  const off = subscribeFullPreview('background-slot-latest', ready, vi.fn())
  await Promise.resolve()
  expect(fetch).toHaveBeenCalledOnce()
  finish(response())
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
  expect(vi.mocked(fetch).mock.calls.map(([source]) => source)).toEqual([
    'background-slot-running',
    'background-slot-latest'
  ])
  off()
})
