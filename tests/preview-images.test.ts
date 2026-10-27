// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (payload: null) => void>()
}))
vi.mock('../src/renderer/src/lib/ipc', () => ({
  ipc: {
    invoke,
    on: (channel: string, listener: (payload: null) => void) => {
      listeners.set(channel, listener)
      return () => {}
    }
  }
}))
import {
  cachedFullPreview,
  cachedSmallPreview,
  loadSmallPreview,
  lookupSmallPreview,
  subscribeFullPreview,
  subscribeFullPreviewBlob,
  thumbnailsIdle
} from '../src/renderer/src/lib/previewImages'

const MiB = 1024 * 1024
let serial = 0
const response = (size = 10) => ({ ok: true, status: 200, blob: async () => ({ size }) })
type Generate = (url: string, options?: RequestInit) => Promise<unknown>
/** Sources that the backend has stored, by body size. Other lookups miss with 204. */
const stored = new Map<string, number>()
let generate: Generate
const generateOnce: Generate[] = []
const isLookup = (url: unknown): boolean => String(url).includes('cacheOnly=1')
const generated = () => vi.mocked(fetch).mock.calls.filter(([url]) => !isLookup(url))
const generatedUrls = () => generated().map(([url]) => url)
const lookedUp = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => isLookup(url))
    .map(([url]) => String(url).replace(/[?&]cacheOnly=1.*$/, ''))
/** Finish the held request whose URL contains `part`. */
const finishFor = (finish: Map<string, () => void>, part: string): void =>
  [...finish].find(([url]) => url.includes(part))![1]()
const once = (next: Generate): void => {
  generateOnce.push(next)
}
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function holdPreviews(): Map<string, () => void> {
  const finish = new Map<string, () => void>()
  generate = (url, options) =>
    new Promise((resolve, reject) => {
      finish.set(url, () => resolve(response()))
      options?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Cancelled', 'AbortError'))
      )
    })
  return finish
}
beforeEach(() => {
  stored.clear()
  generateOnce.length = 0
  generate = async () => response()
  invoke.mockReset().mockImplementation(async (channel) => {
    if (channel === 'editor:beginImageRequest') return { requestId: `small-request-${serial++}` }
    // Each window keeps half: the 64 MiB budget of these tests.
    if (channel === 'cache:memoryBudget') return 128 * MiB
    return undefined
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, options?: RequestInit) => {
      const url = String(input)
      if (!isLookup(url)) return (generateOnce.shift() ?? generate)(url, options)
      const size = stored.get(url.replace(/[?&]cacheOnly=1.*$/, ''))
      return size === undefined ? { ok: true, status: 204 } : response(size)
    })
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
  once(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      })
  )
  const selected = vi.fn()
  let release = subscribeFullPreview(source(0), selected, vi.fn())
  await vi.waitFor(() => expect(generated()).toHaveLength(1))
  for (let i = 1; i <= 20; i++) {
    release()
    release = subscribeFullPreview(source(i), selected, vi.fn())
  }
  expect(generated()).toHaveLength(1)
  finish(response())
  await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(1))
  expect(generatedUrls()).toEqual([source(0), source(20)])
  release()
  const revisit = vi.fn()
  const off = subscribeFullPreview(source(0), revisit, vi.fn())
  expect(revisit).toHaveBeenCalledTimes(1)
  expect(generated()).toHaveLength(2)
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
  await vi.waitFor(() => expect(generated()).toHaveLength(1))
  const request = new URL(String(generated()[0][0]))
  expect(request.searchParams.get('priority')).toBe('low')
  // The foreground preempts only after its stored-image lookup misses.
  const release = subscribeFullPreview('foreground-preempts-medium', ready, vi.fn())
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('editor:endImageRequest', {
      requestId: request.searchParams.get('requestId')
    })
  )
  // The response wins before native acknowledges cancellation: it must not publish stale pixels.
  finish.get(request.toString())!()
  await vi.waitFor(() => expect(errorBackground).toHaveBeenCalledOnce())
  expect(readyBackground).not.toHaveBeenCalled()
  expect(cachedFullPreview(source)).toBeUndefined()
  expect(generated()).toHaveLength(1)
  acknowledge()
  await vi.waitFor(() => expect(generated()).toHaveLength(2))
  finish.get('foreground-preempts-medium')!()
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
  stop()
  release()
})

it('prioritizes foreground after cancelled background preparation and releases evicted object URLs', async () => {
  const neighbor = 'x3f-preview://localhost/neighbor-a'
  let finish!: (result: ReturnType<typeof response>) => void
  once(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      })
  )
  const cancel = subscribeFullPreview(neighbor, vi.fn(), vi.fn(), 'background')
  await vi.waitFor(() => expect(generated()).toHaveLength(1))
  cancel()
  const selected = vi.fn()
  const release = subscribeFullPreview('foreground', selected, vi.fn())
  finish(response(65 * 1024 * 1024))
  await vi.waitFor(() => expect(selected).toHaveBeenCalledTimes(1))
  expect(generatedUrls()).toEqual([neighbor, 'foreground'])
  expect(URL.revokeObjectURL).toHaveBeenCalled()
  expect(cachedFullPreview(neighbor)).toBeUndefined()
  expect(cachedFullPreview('foreground')).toBeDefined()
  release()
  cancel()
})

it('releases a full preview subscription only once so repeated cancellation cannot pin an evicted URL', async () => {
  generate = async () => response(40 * MiB)
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

it('reuses a native edited preview from cache after its viewer leaves', async () => {
  const source = `x3f-edit://localhost/native-${serial++}?v=native`
  const ready = vi.fn()
  const release = subscribeFullPreview(source, ready, vi.fn())
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
  const url = ready.mock.calls[0][0]
  expect(generated()).toHaveLength(1)
  release()
  await settle()
  const revisit = vi.fn()
  const stop = subscribeFullPreview(source, revisit, vi.fn())
  expect(revisit).toHaveBeenCalledWith(url)
  expect(generated()).toHaveLength(1)
  expect(new URL(String(generated()[0][0])).searchParams.get('v')).toBe('native')
  stop()
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
  expect(generated()).toHaveLength(1)
  expect(createImageBitmap).toHaveBeenCalledTimes(1)
  expect(await loadSmallPreview('small-shared', 6, 2, second.signal)).toBe(canvas)
  expect(generated()).toHaveLength(1)
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
  expect(generated()).toHaveLength(8)
})

it('drops small requests whose consumers disappear before extraction starts', async () => {
  const abort = new AbortController()
  const result = loadSmallPreview('small-abandoned', 1, undefined, abort.signal).catch(
    (error) => error.name
  )
  abort.abort()
  expect(await result).toBe('AbortError')
  expect(generated()).toHaveLength(0)
})

it('starts newly visible thumbnails before older queued work while keeping three fetch slots', async () => {
  const finish = holdPreviews()
  const signal = new AbortController().signal
  const first = Array.from({ length: 3 }, (_, i) =>
    loadSmallPreview(`small-priority-${i}`, 1, undefined, signal)
  )
  await vi.waitFor(() => expect(generated()).toHaveLength(3))
  const old = loadSmallPreview('small-priority-old', 1, undefined, signal)
  const latest = loadSmallPreview('small-priority-latest', 1, undefined, signal)
  await Promise.resolve()
  expect(generated()).toHaveLength(3)
  finish.get('small-priority-0')!()
  await vi.waitFor(() => expect(generated()).toHaveLength(4))
  expect(generated()[3][0]).toBe('small-priority-latest')
  finish.forEach((done) => done())
  await vi.waitFor(() => expect(generated()).toHaveLength(5))
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
  await vi.waitFor(() => expect(generated()).toHaveLength(3))
  const latest = loadSmallPreview('small-abort-next', 1, undefined, new AbortController().signal)
  const running = generated().find(([url]) => url === 'small-abort-0')!
  controllers[0].abort()
  expect(await first[0]).toBe('AbortError')
  await vi.waitFor(() => expect(generated()).toHaveLength(4))
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
  await vi.waitFor(() => expect(generated()).toHaveLength(3))
  const latest = loadSmallPreview('small-native-next', 1, undefined, new AbortController().signal)
  controllers.forEach((controller) => controller.abort())
  await Promise.all(first)
  expect(generated()).toHaveLength(3)
  expect(generated().every(([, options]) => !options?.signal?.aborted)).toBe(true)
  finish.forEach((done) => done())
  await vi.waitFor(() => expect(generated()).toHaveLength(4))
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
  await vi.waitFor(() => expect(generated()).toHaveLength(1))
  first.abort()
  const next = loadSmallPreview('small-handoff', 1, undefined, new AbortController().signal)
  await Promise.resolve()
  expect(generated()[0][1]?.signal?.aborted).toBe(false)
  finish.get('small-handoff')!()
  expect(await old).toBe('AbortError')
  await next
  expect(generated()).toHaveLength(1)
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
  await vi.waitFor(() => expect(generated()).toHaveLength(1))
  const [request, options] = generated()[0]
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
  expect(generated()).toHaveLength(0)
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
  once(async () => ({ ok: false, status: 503 }))
  const url = 'http://x3f-edit.localhost/retry?v=thumbnail'
  const signal = new AbortController().signal
  await expect(loadSmallPreview(url, 1, undefined, signal)).rejects.toThrow('preview 503')
  const retry = await loadSmallPreview(url, 1, undefined, signal)
  expect(retry.width).toBe(640)
  expect(generated()).toHaveLength(2)
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'editor:endImageRequest')
  ).toHaveLength(2)
  finishEnding()
  expect(await loadSmallPreview(url, 1, undefined, signal)).toBe(retry)
  expect(invoke).toHaveBeenCalledTimes(4)
})

it('keeps cached full URLs alive across viewer handoff while pinned images exceed the budget', async () => {
  generate = async () => response(40 * MiB)
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
  expect(generated()).toHaveLength(2)
  releaseNext()
  releaseB()
  await Promise.resolve()
})

it('never lets fit background preparation replace a pending foreground full request', async () => {
  let finish!: (result: ReturnType<typeof response>) => void
  once(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      })
  )
  const first = vi.fn(),
    foreground = vi.fn(),
    background = vi.fn()
  const releaseFirst = subscribeFullPreview('priority-running', first, vi.fn())
  await vi.waitFor(() => expect(generated()).toHaveLength(1))
  const releaseForeground = subscribeFullPreview('priority-foreground', foreground, vi.fn())
  const releaseBackground = subscribeFullPreviewBlob(
    'priority-background',
    background,
    vi.fn(),
    'background'
  )
  finish(response())
  await vi.waitFor(() => expect(background).toHaveBeenCalledOnce())
  expect(generatedUrls()).toEqual([
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
  once(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      })
  )
  const release = subscribeFullPreview('background-slot-running', vi.fn(), vi.fn(), 'background')
  await vi.waitFor(() => expect(generated()).toHaveLength(1))
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
  expect(generated()).toHaveLength(1)
  finish(response())
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
  expect(generatedUrls()).toEqual(['background-slot-running', 'background-slot-latest'])
  off()
})

it('draws edited frames from raw RGBA8 without a PNG decode', async () => {
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number
      ) {}
    }
  )
  const body = new ArrayBuffer(16 + 2 * 1 * 4)
  new Uint8Array(body).set([...'X3F8'].map((c) => c.charCodeAt(0)))
  new DataView(body).setUint32(4, 2, true)
  new DataView(body).setUint32(8, 1, true)
  once(async () => ({ ok: true, arrayBuffer: async () => body }))
  const draw = vi.fn()
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
    setTransform: vi.fn(),
    drawImage: draw
  } as unknown as CanvasRenderingContext2D)
  const url = 'x3f-edit://localhost/raw-frame'
  await loadSmallPreview(url, 1, undefined, new AbortController().signal)
  expect(generated()).toHaveLength(1)
  const request = new URL(String(generated()[0][0]))
  expect(request.searchParams.get('format')).toBe('rgba8')
  expect(createImageBitmap).toHaveBeenCalledWith(expect.objectContaining({ width: 2, height: 1 }))
  const bitmap = await vi.mocked(createImageBitmap).mock.results[0].value
  expect(draw.mock.calls[0][0]).toBe(bitmap)
  expect(bitmap.close).toHaveBeenCalledOnce()
  expect(invoke).toHaveBeenLastCalledWith('editor:endImageRequest', {
    requestId: request.searchParams.get('requestId')
  })
})

it('serves stored original and edited thumbnails while three edited misses hold every edited slot', async () => {
  const finish = holdPreviews()
  const signal = new AbortController().signal
  const misses = [0, 1, 2].map((i) =>
    loadSmallPreview(`x3f-edit://localhost/miss-${i}?v=thumbnail`, 1, undefined, signal)
  )
  await vi.waitFor(() => expect(generated()).toHaveLength(3))
  stored.set('x3f-preview://localhost/stored-original?v=preview', 10)
  stored.set('x3f-edit://localhost/stored-edited?v=thumbnail', 10)
  const original = await loadSmallPreview(
    'x3f-preview://localhost/stored-original?v=preview',
    6,
    2,
    signal
  )
  const edited = await loadSmallPreview(
    'x3f-edit://localhost/stored-edited?v=thumbnail',
    1,
    undefined,
    signal
  )
  expect([original.width, original.height]).toEqual([320, 640])
  expect(edited.width).toBe(640)
  expect(generated()).toHaveLength(3)
  // Lookups register no native request; only the three renders did.
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'editor:beginImageRequest')
  ).toHaveLength(3)
  expect(thumbnailsIdle()).toBe(false)
  finish.forEach((done) => done())
  await Promise.all(misses)
  await vi.waitFor(() => expect(thumbnailsIdle()).toBe(true))
})

it('generates the selected photo before visible thumbnails and asks native for high priority', async () => {
  const finish = holdPreviews()
  const signal = new AbortController().signal
  const first = [0, 1, 2].map((i) =>
    loadSmallPreview(`x3f-edit://localhost/busy-${i}?v=thumbnail`, 1, undefined, signal)
  )
  await vi.waitFor(() => expect(generated()).toHaveLength(3))
  const visible = loadSmallPreview('x3f-edit://localhost/visible?v=thumbnail', 1, undefined, signal)
  const selected = loadSmallPreview(
    'x3f-edit://localhost/selected?v=thumbnail',
    1,
    undefined,
    signal,
    'selected'
  )
  await settle()
  const newer = loadSmallPreview('x3f-edit://localhost/newer?v=thumbnail', 1, undefined, signal)
  await settle()
  finishFor(finish, '/busy-0')
  await vi.waitFor(() => expect(generated()).toHaveLength(4))
  const request = new URL(String(generatedUrls()[3]))
  expect(request.pathname).toBe('/selected')
  expect(request.searchParams.get('priority')).toBe('high')
  finishFor(finish, '/busy-1')
  await vi.waitFor(() => expect(generated()).toHaveLength(5))
  expect(new URL(String(generatedUrls()[4])).pathname).toBe('/newer')
  finish.forEach((done) => done())
  await vi.waitFor(() => expect(generated()).toHaveLength(6))
  expect(new URL(String(generatedUrls()[5])).searchParams.get('priority')).toBe('normal')
  finish.forEach((done) => done())
  await Promise.all([...first, visible, selected, newer])
})

it('runs original and edited misses in separate lanes, even behind abandoned embedded extraction', async () => {
  const finish = holdPreviews()
  const signal = new AbortController().signal
  const edited = (name: string): string => `x3f-edit://localhost/${name}?v=thumbnail`
  const embedded = (name: string): string => `x3f-preview://localhost/${name}?v=preview`
  // Abandoned embedded extraction cannot cancel; it keeps every original slot.
  const controllers = [0, 1, 2].map(() => new AbortController())
  const abandoned = controllers.map((controller, i) =>
    loadSmallPreview(embedded(`lane-held-${i}`), 1, undefined, controller.signal).catch(
      (error) => error.name
    )
  )
  await vi.waitFor(() => expect(generated()).toHaveLength(3))
  controllers.forEach((controller) => controller.abort())
  expect(await Promise.all(abandoned)).toEqual(['AbortError', 'AbortError', 'AbortError'])
  const waitingOriginal = loadSmallPreview(embedded('lane-waiting'), 1, undefined, signal)
  const editedMisses = [0, 1, 2].map((i) =>
    loadSmallPreview(edited(`lane-${i}`), 1, undefined, signal)
  )
  await vi.waitFor(() => expect(generated()).toHaveLength(6))
  const waitingEdited = loadSmallPreview(edited('lane-waiting'), 1, undefined, signal)
  await settle()
  // Both lanes are full: each waiting miss stays queued.
  expect(generated()).toHaveLength(6)
  // A free original slot starts only the original miss.
  finishFor(finish, '/lane-held-0')
  await vi.waitFor(() => expect(generated()).toHaveLength(7))
  expect(generatedUrls()[6]).toBe(embedded('lane-waiting'))
  // A free edited slot starts only the edited miss.
  finishFor(finish, '/lane-0?')
  await vi.waitFor(() => expect(generated()).toHaveLength(8))
  expect(new URL(String(generatedUrls()[7])).pathname).toBe('/lane-waiting')
  finish.forEach((done) => done())
  await Promise.all([waitingOriginal, waitingEdited, ...editedMisses])
  await vi.waitFor(() => expect(thumbnailsIdle()).toBe(true))
})

it('looks up stored thumbnails without generation and keeps them for loadSmallPreview', async () => {
  const finish = holdPreviews()
  const signal = new AbortController().signal
  const busy = [0, 1, 2].map((i) =>
    loadSmallPreview(`x3f-preview://localhost/lookup-busy-${i}`, 1, undefined, signal)
  )
  await vi.waitFor(() => expect(generated()).toHaveLength(3))
  const url = 'x3f-edit://localhost/lookup-hit?v=thumbnail'
  stored.set(url, 10)
  const canvas = await lookupSmallPreview(url, 6, 2, signal)
  expect([canvas?.width, canvas?.height]).toEqual([320, 640])
  expect(cachedSmallPreview(url, 6, 2)).toBe(canvas)
  // A memory hit makes no request.
  const lookups = lookedUp().length
  expect(await lookupSmallPreview(url, 6, 2, signal)).toBe(canvas)
  expect(lookedUp()).toHaveLength(lookups)
  expect(await loadSmallPreview(url, 6, 2, signal)).toBe(canvas)
  // Another orientation of the same URL is another thumbnail.
  expect(cachedSmallPreview(url, 1, undefined)).toBeUndefined()
  expect(generated()).toHaveLength(3)
  expect(invoke.mock.calls.some(([channel]) => channel === 'editor:beginImageRequest')).toBe(false)
  finish.forEach((done) => done())
  await Promise.all(busy)
})

it('resolves a thumbnail lookup miss as undefined without generation or a memory entry', async () => {
  const url = 'x3f-edit://localhost/lookup-miss?v=thumbnail'
  expect(await lookupSmallPreview(url, 1, undefined, new AbortController().signal)).toBeUndefined()
  expect(lookedUp()).toEqual([url])
  expect(generated()).toHaveLength(0)
  expect(cachedSmallPreview(url)).toBeUndefined()
  expect(thumbnailsIdle()).toBe(true)
})

it('rejects aborted thumbnail lookups and keeps no pixels', async () => {
  const url = 'x3f-preview://localhost/lookup-abort?v=preview'
  stored.set(url, 10)
  const before = new AbortController()
  before.abort()
  await expect(lookupSmallPreview(url, 1, undefined, before.signal)).rejects.toThrow('Cancelled')
  expect(lookedUp()).toHaveLength(0)
  vi.mocked(fetch).mockImplementationOnce(
    (_, options) =>
      new Promise((_, reject) =>
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Cancelled', 'AbortError'))
        )
      )
  )
  const during = new AbortController()
  const result = lookupSmallPreview(url, 1, undefined, during.signal).catch((error) => error.name)
  await vi.waitFor(() => expect(lookedUp()).toEqual([url]))
  during.abort()
  expect(await result).toBe('AbortError')
  expect(cachedSmallPreview(url)).toBeUndefined()
  expect(createImageBitmap).not.toHaveBeenCalled()
  expect(generated()).toHaveLength(0)
})

it('keeps no thumbnail lookup result that started before cache:cleared', async () => {
  const url = 'x3f-preview://localhost/lookup-clear?v=preview'
  const signal = new AbortController().signal
  stored.set(url, 10)
  const before = await lookupSmallPreview(url, 1, undefined, signal)
  expect(cachedSmallPreview(url)).toBe(before)
  let respond!: () => void
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        respond = () => resolve(response() as unknown as Response)
      })
  )
  const late = 'x3f-preview://localhost/lookup-clear-late?v=preview'
  const result = lookupSmallPreview(late, 1, undefined, signal)
  await vi.waitFor(() => expect(respond).toBeDefined())
  listeners.get('cache:cleared')!(null)
  expect(cachedSmallPreview(url)).toBeUndefined()
  respond()
  // The caller gets the pixels, but memory keeps no result of earlier work.
  expect(await result).toBeDefined()
  await settle()
  expect(cachedSmallPreview(late)).toBeUndefined()
  // A new lookup after the Clear stays in memory again.
  const again = await lookupSmallPreview(url, 1, undefined, signal)
  expect(again).not.toBe(before)
  expect(cachedSmallPreview(url)).toBe(again)
})

it('shows a stored full JPEG at once while an extraction that cannot cancel holds the slot', async () => {
  const finish = holdPreviews()
  const slow = 'x3f-preview://localhost/slow?v=full'
  const leave = subscribeFullPreview(slow, vi.fn(), vi.fn())
  await vi.waitFor(() => expect(generated()).toHaveLength(1))
  leave()
  const source = 'x3f-preview://localhost/stored?v=full'
  stored.set(source, 10)
  const ready = vi.fn()
  const off = subscribeFullPreview(source, ready, vi.fn())
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
  expect(cachedFullPreview(source)).toBe(ready.mock.calls[0][0])
  expect(generatedUrls()).toEqual([slow])
  expect(lookedUp()).toEqual([slow, source])
  off()
  finish.get(slow)!()
  await vi.waitFor(() => expect(cachedFullPreview(slow)).toBeDefined())
})

it('drops idle images on cache:cleared, keeps displayed ones, and keeps no result of earlier work', async () => {
  const shown = vi.fn()
  const offShown = subscribeFullPreview('clear-shown', shown, vi.fn())
  await vi.waitFor(() => expect(shown).toHaveBeenCalledOnce())
  const idle = vi.fn()
  const offIdle = subscribeFullPreview('clear-idle', idle, vi.fn())
  await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce())
  offIdle()
  await loadSmallPreview('clear-small', 1, undefined, new AbortController().signal)
  expect(cachedSmallPreview('clear-small')).toBeDefined()
  const finish = holdPreviews()
  const late = vi.fn()
  const offLate = subscribeFullPreview('clear-late', late, vi.fn())
  await vi.waitFor(() => expect(generatedUrls()).toContain('clear-late'))

  listeners.get('cache:cleared')!(null)
  expect(cachedFullPreview('clear-idle')).toBeUndefined()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(idle.mock.calls[0][0])
  expect(cachedSmallPreview('clear-small')).toBeUndefined()
  expect(cachedFullPreview('clear-shown')).toBe(shown.mock.calls[0][0])
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(shown.mock.calls[0][0])

  // Work from before the Clear still shows, but stays only while it is displayed.
  finish.get('clear-late')!()
  await vi.waitFor(() => expect(late).toHaveBeenCalledOnce())
  await settle()
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(late.mock.calls[0][0])
  offLate()
  await settle()
  expect(cachedFullPreview('clear-late')).toBeUndefined()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(late.mock.calls[0][0])
  offShown()
  await settle()
  expect(cachedFullPreview('clear-shown')).toBeUndefined()

  // New work after the Clear stays in memory again.
  generate = async () => response()
  const again = vi.fn()
  const offAgain = subscribeFullPreview('clear-shown', again, vi.fn())
  await vi.waitFor(() => expect(again).toHaveBeenCalledOnce())
  offAgain()
  await settle()
  expect(cachedFullPreview('clear-shown')).toBe(again.mock.calls[0][0])
})
