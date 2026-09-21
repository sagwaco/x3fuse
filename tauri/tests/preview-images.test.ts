// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))
import {
  cachedFullPreview,
  cachedSmallPreview,
  loadSmallPreview,
  subscribeFullPreview,
  subscribeFullPreviewBlob
} from '../src/renderer/src/lib/previewImages'

let serial = 0
const response = (size = 10) => ({ ok: true, blob: async () => ({ size }) })
function holdPreviews(): Map<string, () => void> {
  const finish = new Map<string, () => void>()
  vi.mocked(fetch).mockImplementation(
    (url, options) =>
      new Promise((resolve, reject) => {
        finish.set(String(url), () => resolve(response() as Response))
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Cancelled', 'AbortError'))
        )
      })
  )
  return finish
}
beforeEach(() => {
  invoke
    .mockReset()
    .mockImplementation(async (channel) =>
      channel === 'editor:beginImageRequest'
        ? { requestId: `small-request-${serial++}` }
        : undefined
    )
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
  const source = (i: number): string => `x3f-preview://localhost/rapid-${i}`
  let finish!: (result: ReturnType<typeof response>) => void
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      })
  )
  const selected = vi.fn()
  let release = subscribeFullPreview(source(0), selected, vi.fn())
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  for (let i = 1; i <= 20; i++) {
    release()
    release = subscribeFullPreview(source(i), selected, vi.fn())
  }
  expect(fetch).toHaveBeenCalledTimes(1)
  finish(response())
  await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(1))
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([source(0), source(20)])
  release()
  const revisit = vi.fn()
  const off = subscribeFullPreview(source(0), revisit, vi.fn())
  expect(revisit).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  off()
})

it('preempts edited background processing and drops responses racing native cancellation', async () => {
  const finish = holdPreviews()
  let acknowledge!: () => void
  invoke.mockImplementation(async (channel) => {
    if (channel === 'editor:beginImageRequest') return { requestId: `medium-${serial++}` }
    return new Promise<void>((resolve) => {
      acknowledge = resolve
    })
  })
  const source = `x3f-edit://localhost/medium-background-${serial++}`
  const readyBackground = vi.fn(),
    errorBackground = vi.fn(),
    ready = vi.fn()
  const stop = subscribeFullPreview(source, readyBackground, errorBackground, 'background')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  const request = new URL(String(vi.mocked(fetch).mock.calls[0][0]))
  const release = subscribeFullPreview('foreground-preempts-medium', ready, vi.fn())
  expect(invoke).toHaveBeenCalledWith('editor:endImageRequest', {
    requestId: request.searchParams.get('requestId')
  })
  // The response wins before native acknowledges cancellation: it must not publish stale pixels.
  finish.get(request.toString())!()
  await vi.waitFor(() => expect(errorBackground).toHaveBeenCalledOnce())
  expect(readyBackground).not.toHaveBeenCalled()
  expect(cachedFullPreview(source)).toBeUndefined()
  expect(fetch).toHaveBeenCalledOnce()
  acknowledge()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  finish.get('foreground-preempts-medium')!()
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
  stop()
  release()
})

it('prioritizes foreground after cancelled background preparation and releases evicted object URLs', async () => {
  const neighbor = 'x3f-preview://localhost/neighbor-a'
  let finish!: (result: ReturnType<typeof response>) => void
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      })
  )
  const cancel = subscribeFullPreview(neighbor, vi.fn(), vi.fn(), 'background')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  cancel()
  const selected = vi.fn()
  const release = subscribeFullPreview('foreground', selected, vi.fn())
  finish(response(65 * 1024 * 1024))
  await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(1))
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([neighbor, 'foreground'])
  expect(URL.revokeObjectURL).toHaveBeenCalled()
  expect(cachedFullPreview(neighbor)).toBeUndefined()
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

it('keeps edited thumbnails small enough to survive scrolling through neighboring previews', async () => {
  vi.mocked(createImageBitmap).mockImplementation(
    async () =>
      ({
        width: 2048,
        height: 1365,
        close: vi.fn()
      }) as unknown as ImageBitmap
  )
  const signal = new AbortController().signal
  const canvases = []
  for (let i = 0; i < 8; i++) {
    canvases.push(await loadSmallPreview(`edited-neighbor-${i}`, 1, undefined, signal))
  }
  expect(canvases.every((canvas) => canvas.width === 640 && canvas.height === 427)).toBe(true)
  expect(cachedSmallPreview('edited-neighbor-0')).toBe(canvases[0])
  expect(await loadSmallPreview('edited-neighbor-0', 1, undefined, signal)).toBe(canvases[0])
  expect(fetch).toHaveBeenCalledTimes(8)
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

it('starts newly visible thumbnails before older queued work while keeping three fetch slots', async () => {
  const finish = holdPreviews()
  const signal = new AbortController().signal
  const first = Array.from({ length: 3 }, (_, i) =>
    loadSmallPreview(`small-priority-${i}`, 1, undefined, signal)
  )
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
  const old = loadSmallPreview('small-priority-old', 1, undefined, signal)
  const latest = loadSmallPreview('small-priority-latest', 1, undefined, signal)
  await Promise.resolve()
  expect(fetch).toHaveBeenCalledTimes(3)
  finish.get('small-priority-0')!()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
  expect(vi.mocked(fetch).mock.calls[3][0]).toBe('small-priority-latest')
  finish.forEach((done) => done())
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5))
  finish.get('small-priority-old')!()
  await Promise.all([...first, old, latest])
})

it('aborts an abandoned browser fetch to start the next visible thumbnail', async () => {
  const finish = holdPreviews()
  const controllers = Array.from({ length: 3 }, () => new AbortController())
  const first = controllers.map((controller, i) =>
    loadSmallPreview(`small-abort-${i}`, 1, undefined, controller.signal).catch(
      (error) => error.name
    )
  )
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
  const latest = loadSmallPreview('small-abort-next', 1, undefined, new AbortController().signal)
  const running = vi.mocked(fetch).mock.calls.find(([url]) => url === 'small-abort-0')!
  controllers[0].abort()
  expect(await first[0]).toBe('AbortError')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
  expect(running[1]?.signal?.aborted).toBe(true)
  finish.forEach((done) => done())
  await Promise.all([...first, latest])
})

it('keeps abandoned embedded extraction bounded and skips unused thumbnail decoding', async () => {
  const finish = holdPreviews()
  const urls = [
    'x3f-preview://localhost/abandoned',
    'http://x3f-preview.localhost/abandoned',
    'https://x3f-preview.localhost/abandoned'
  ]
  const controllers = urls.map(() => new AbortController())
  const first = urls.map((url, i) =>
    loadSmallPreview(url, 1, undefined, controllers[i].signal).catch((error) => error.name)
  )
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
  const latest = loadSmallPreview('small-native-next', 1, undefined, new AbortController().signal)
  controllers.forEach((controller) => controller.abort())
  await Promise.all(first)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.signal?.aborted)).toBe(true)
  finish.forEach((done) => done())
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
  expect(createImageBitmap).not.toHaveBeenCalled()
  finish.get('small-native-next')!()
  await latest
  expect(createImageBitmap).toHaveBeenCalledOnce()
})

it('shares a running thumbnail through a synchronous view handoff', async () => {
  const finish = holdPreviews()
  const first = new AbortController()
  const old = loadSmallPreview('small-handoff', 1, undefined, first.signal).catch(
    (error) => error.name
  )
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  first.abort()
  const next = loadSmallPreview('small-handoff', 1, undefined, new AbortController().signal)
  await Promise.resolve()
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(false)
  finish.get('small-handoff')!()
  expect(await old).toBe('AbortError')
  await next
  expect(fetch).toHaveBeenCalledOnce()
})

it('cancels edited native work before aborting its shared thumbnail fetch', async () => {
  const finish = holdPreviews()
  let acknowledge!: () => void
  invoke.mockImplementation(async (channel) =>
    channel === 'editor:beginImageRequest'
      ? { requestId: 'edited-cancel' }
      : new Promise<void>((resolve) => {
          acknowledge = resolve
        })
  )
  const url = 'x3f-edit://localhost/edited-cancel?v=thumbnail'
  const first = new AbortController(),
    second = new AbortController()
  const a = loadSmallPreview(url, 1, undefined, first.signal).catch((error) => error.name)
  const b = loadSmallPreview(url, 1, undefined, second.signal).catch((error) => error.name)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  const [request, options] = vi.mocked(fetch).mock.calls[0]
  expect(new URL(String(request)).searchParams.get('requestId')).toBe('edited-cancel')
  expect(new URL(String(request)).searchParams.get('v')).toBe('thumbnail')
  first.abort()
  await a
  expect(invoke).toHaveBeenCalledTimes(1)
  second.abort()
  await b
  expect(invoke).toHaveBeenLastCalledWith('editor:endImageRequest', { requestId: 'edited-cancel' })
  expect(options?.signal?.aborted).toBe(false)
  acknowledge()
  await vi.waitFor(() => expect(options?.signal?.aborted).toBe(true))
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(createImageBitmap).not.toHaveBeenCalled()
  finish.forEach((done) => done())
})

it('ends edited requests cancelled during registration without starting their fetch', async () => {
  let registered!: (result: { requestId: string }) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        registered = resolve
      })
  )
  const controller = new AbortController()
  const result = loadSmallPreview(
    'http://x3f-edit.localhost/registration?v=thumbnail',
    1,
    undefined,
    controller.signal
  ).catch((error) => error.name)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
  controller.abort()
  expect(await result).toBe('AbortError')
  registered({ requestId: 'registration-cancel' })
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  expect(invoke).toHaveBeenLastCalledWith('editor:endImageRequest', {
    requestId: 'registration-cancel'
  })
  expect(fetch).not.toHaveBeenCalled()
})

it('allows retry while a failed edited request is still ending and closes successful requests', async () => {
  let finishEnding!: () => void
  invoke.mockImplementation((channel) => {
    if (channel === 'editor:beginImageRequest')
      return Promise.resolve({ requestId: 'edited-retry' })
    if (!finishEnding)
      return new Promise<void>((resolve) => {
        finishEnding = resolve
      })
    return Promise.resolve()
  })
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response)
  const url = 'http://x3f-edit.localhost/retry?v=thumbnail'
  const signal = new AbortController().signal
  await expect(loadSmallPreview(url, 1, undefined, signal)).rejects.toThrow('preview 503')
  const retry = await loadSmallPreview(url, 1, undefined, signal)
  expect(retry.width).toBe(640)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'editor:endImageRequest')
  ).toHaveLength(2)
  finishEnding()
  expect(await loadSmallPreview(url, 1, undefined, signal)).toBe(retry)
  expect(invoke).toHaveBeenCalledTimes(4)
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
