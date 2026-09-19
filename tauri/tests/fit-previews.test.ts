// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FitPreview } from '../src/renderer/src/lib/fitPreviews'

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }))
vi.mock('../src/renderer/src/lib/previewImages', () => ({ subscribeFullPreviewBlob: transport }))
let service: typeof import('../src/renderer/src/lib/fitPreviews')
const workers: FakeWorker[] = []
class FakeWorker {
  postMessage = vi.fn()
  terminate = vi.fn()
  onmessage?: (event: MessageEvent) => void
  onerror?: (event: ErrorEvent) => void
  constructor() {
    workers.push(this)
  }
  reply(result: ReturnType<typeof output> | { failed: true }): void {
    this.onmessage?.({
      data: { id: this.postMessage.mock.calls.at(-1)![0].id, ...result }
    } as MessageEvent)
  }
}

function output(size = 10) {
  const blob = new Blob(['medium'], { type: 'image/jpeg' })
  Object.defineProperty(blob, 'size', { value: size })
  return {
    image: { width: 2048, height: 2048, close: vi.fn() } as unknown as ImageBitmap,
    width: 6000,
    height: 6000,
    blob
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

async function load(source: string, result = output()) {
  const ready = vi.fn(),
    error = vi.fn()
  const release = service.subscribeFitPreview(source, ready, error)
  await settle()
  workers[0].reply(result)
  await settle()
  expect(ready).toHaveBeenCalledOnce()
  expect(error).not.toHaveBeenCalled()
  return { ready, release, result }
}

beforeEach(async () => {
  vi.resetModules()
  workers.length = 0
  vi.stubGlobal('Worker', FakeWorker)
  transport.mockReset().mockImplementation((_source, ready) => {
    ready(new Blob(['full'], { type: 'image/jpeg' }))
    return vi.fn()
  })
  service = await import('../src/renderer/src/lib/fitPreviews')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fit previews', () => {
  it('deduplicates pending preparation, preserves original dimensions, and provides synchronous decoded hits', async () => {
    const first = vi.fn(),
      second = vi.fn(),
      error = vi.fn()
    const offFirst = service.subscribeFitPreview('same?rev=1', first, error)
    const offSecond = service.subscribeFitPreview('same?rev=1', second, error)
    await settle()
    expect(transport).toHaveBeenCalledOnce()
    expect(workers[0].postMessage).toHaveBeenCalledOnce()
    const result = output()
    result.width = 4000
    result.height = 6000
    workers[0].reply(result)
    await settle()
    expect(first.mock.calls[0][0]).toMatchObject({ image: result.image, width: 4000, height: 6000 })
    expect(second.mock.calls[0][0]).toBe(first.mock.calls[0][0])
    offFirst()
    expect(result.image.close).not.toHaveBeenCalled()
    const revisit = vi.fn()
    const offRevisit = service.subscribeFitPreview('same?rev=1', revisit, error)
    expect(revisit).toHaveBeenCalledWith(service.cachedFitPreview('same?rev=1'))
    expect(transport).toHaveBeenCalledOnce()
    offSecond()
    offRevisit()
  })

  it('drops cancelled queued selections and closes stale worker output before preparing the latest selection', async () => {
    const ready = vi.fn(),
      error = vi.fn()
    let release = service.subscribeFitPreview('rapid-0', ready, error)
    await settle()
    for (let i = 1; i <= 20; i++) {
      release()
      release = service.subscribeFitPreview(`rapid-${i}`, ready, error)
    }
    await settle()
    expect(transport).toHaveBeenCalledOnce()
    const stale = output()
    workers[0].reply(stale)
    await settle()
    expect(stale.image.close).toHaveBeenCalledOnce()
    expect(ready).not.toHaveBeenCalled()
    expect(transport.mock.calls.map(([source]) => source)).toEqual(['rapid-0', 'rapid-20'])
    workers[0].reply(output())
    await settle()
    expect(ready).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
    release()
  })

  it('supersedes background transport with foreground and cancels abandoned prefetch targets', async () => {
    const deliveries: Array<{
      source: string
      ready: (blob: Blob) => void
      release: ReturnType<typeof vi.fn>
    }> = []
    transport.mockImplementation((source, ready) => {
      const release = vi.fn()
      deliveries.push({ source, ready, release })
      return release
    })
    const stop = service.prefetchFitPreviews(['background-a', 'background-b'])
    await settle()
    expect(transport.mock.calls[0][3]).toBe('background')
    const ready = vi.fn()
    const release = service.subscribeFitPreview('foreground', ready, vi.fn())
    await settle()
    expect(deliveries[0].release).toHaveBeenCalled()
    expect(transport.mock.calls.map(([source]) => source)).toEqual(['background-a', 'foreground'])
    expect(transport.mock.calls[1][3]).toBe('foreground')
    stop()
    deliveries[0].ready(new Blob(['obsolete']))
    deliveries[1].ready(new Blob(['current']))
    await settle()
    expect(workers[0].postMessage).toHaveBeenCalledOnce()
    workers[0].reply(output())
    await settle()
    expect(ready).toHaveBeenCalledOnce()
    expect(transport).toHaveBeenCalledTimes(2)
    release()
  })

  it('keeps active images pinned within decoded LRU eviction and re-decodes encoded hits without native extraction', async () => {
    const pinned = await load('pinned')
    const old = await load('old')
    old.release()
    for (let i = 0; i < 3; i++) (await load(`fill-${i}`)).release()
    await settle()
    expect(pinned.result.image.close).not.toHaveBeenCalled()
    expect(old.result.image.close).toHaveBeenCalledOnce()
    expect(service.cachedFitPreview('old')).toBeUndefined()
    const calls = transport.mock.calls.length
    const restored = vi.fn()
    const release = service.subscribeFitPreview('old', restored, vi.fn())
    await settle()
    expect(transport).toHaveBeenCalledTimes(calls)
    expect(workers[0].postMessage.mock.calls.at(-1)![0]).toMatchObject({
      blob: old.result.blob,
      original: { width: 6000, height: 6000 }
    })
    workers[0].reply(output())
    await settle()
    expect(restored).toHaveBeenCalledOnce()
    pinned.release()
    release()
  })

  it('caps both caches and does not regenerate completed queue entries after eviction', async () => {
    const sources = Array.from({ length: 5 }, (_, i) => `queue-${i}`)
    const results = sources.map(() => output(48 * 1024 * 1024))
    for (let i = 0; i < sources.length; i++) (await load(sources[i], results[i])).release()
    await settle()
    expect(transport).toHaveBeenCalledTimes(5)
    expect(results[0].image.close).toHaveBeenCalledOnce()
    expect(service.cachedFitPreview(sources[0])).toBeUndefined()
    // Existing decoded entries are the warm neighbors; the evicted entry is only background.
    const stopAgain = service.prefetchFitPreviews([...sources.slice(1), sources[0]])
    await settle()
    expect(transport).toHaveBeenCalledTimes(5)
    const ready = vi.fn()
    const release = service.subscribeFitPreview(sources[0], ready, vi.fn())
    await settle()
    // The 128 MiB encoded cache only retains two of these 48 MiB test entries.
    expect(transport).toHaveBeenCalledTimes(6)
    workers[0].reply(output())
    await settle()
    expect(ready).toHaveBeenCalledOnce()
    release()
    stopAgain()
  })

  it('keeps nearby decoded previews warm during a long scan and rehydrates newly nearby encoded previews', async () => {
    const sources = Array.from({ length: 9 }, (_, i) => `warm-${i}`)
    const stop = service.prefetchFitPreviews(sources)
    await settle()
    for (let i = 0; i < sources.length; i++) {
      workers[0].reply(output())
      await settle()
    }
    for (const source of sources.slice(0, 4)) expect(service.cachedFitPreview(source)).toBeDefined()
    expect(service.cachedFitPreview(sources[8])).toBeUndefined()
    expect(transport).toHaveBeenCalledTimes(9)
    stop()
    const stopNext = service.prefetchFitPreviews([
      sources[8],
      sources[7],
      sources[6],
      sources[5],
      ...sources.slice(0, 5)
    ])
    await settle()
    for (let i = 0; i < 4; i++) {
      expect(workers[0].postMessage.mock.calls.at(-1)![0].original).toEqual({
        width: 6000,
        height: 6000
      })
      workers[0].reply(output())
      await settle()
    }
    for (const source of sources.slice(5)) expect(service.cachedFitPreview(source)).toBeDefined()
    expect(transport).toHaveBeenCalledTimes(9)
    expect(workers[0].postMessage).toHaveBeenCalledTimes(13)
    stopNext()
  })

  it('downsamples asynchronously with original portrait dimensions when the worker fails', async () => {
    const full = { width: 3000, height: 6000, close: vi.fn() }
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => full)
    )
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['medium']))
    )
    const ready = vi.fn<(preview: FitPreview) => void>(),
      error = vi.fn()
    const release = service.subscribeFitPreview('portrait', ready, error)
    await settle()
    workers[0].reply({ failed: true })
    await settle()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
      imageOrientation: 'from-image'
    })
    expect(ready).toHaveBeenCalledOnce()
    expect(ready.mock.calls[0][0]).toMatchObject({ width: 3000, height: 6000 })
    expect([ready.mock.calls[0][0].image.width, ready.mock.calls[0][0].image.height]).toEqual([
      1024, 2048
    ])
    expect(drawImage).toHaveBeenCalledWith(full, 0, 0, 1024, 2048)
    expect(full.close).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
    release()
  })

  it('generates the worker medium with EXIF-aware decoding and original oriented dimensions', async () => {
    const full = { width: 2730, height: 4096, close: vi.fn() }
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => full)
    )
    const medium = new Blob(['jpeg'], { type: 'image/jpeg' })
    const drawImage = vi.fn(),
      encode = vi.fn(async () => medium)
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number
        ) {}
        getContext() {
          return { drawImage }
        }
        convertToBlob = encode
        transferToImageBitmap() {
          return { width: this.width, height: this.height, close: vi.fn() }
        }
      }
    )
    const post = vi.spyOn(self, 'postMessage').mockImplementation(() => {})
    const previous = self.onmessage
    try {
      await import('../src/renderer/src/lib/fitPreview.worker')
      const blob = new Blob(['full'])
      await self.onmessage!({ data: { id: 3, blob } } as MessageEvent)
      expect(createImageBitmap).toHaveBeenCalledWith(blob, { imageOrientation: 'from-image' })
      expect(drawImage).toHaveBeenCalledWith(full, 0, 0, 1365, 2048)
      expect(encode).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.9 })
      expect(post.mock.calls[0][0]).toMatchObject({
        id: 3,
        width: 2730,
        height: 4096,
        blob: medium
      })
      expect(post.mock.calls[0][0].image.width).toBe(1365)
      expect(full.close).toHaveBeenCalledOnce()
    } finally {
      self.onmessage = previous
    }
  })
})
