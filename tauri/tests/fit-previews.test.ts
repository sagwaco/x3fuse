// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FitPreview } from '../src/renderer/src/lib/fitPreviews'

const { transport, loadFrame } = vi.hoisted(() => ({ transport: vi.fn(), loadFrame: vi.fn() }))
vi.mock('../src/renderer/src/lib/previewImages', () => ({ subscribeFullPreviewBlob: transport }))
vi.mock('../src/renderer/src/lib/frames', async (original) => ({
  ...(await original<typeof import('../src/renderer/src/lib/frames')>()),
  loadFrame
}))
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
  it('warms edited frames without the worker and releases them on eviction', async () => {
    const frames: Array<{ image: ImageBitmap; release: () => void }> = []
    loadFrame.mockImplementation(async () => {
      const image = { width: 4096, height: 4096, close: vi.fn() } as unknown as ImageBitmap
      const frame = { image, width: 4096, height: 4096, release: vi.fn() }
      frames.push(frame)
      return frame
    })
    const sources = [
      'x3f-edit://localhost/edited-a',
      'http://x3f-edit.localhost/edited-b',
      'x3f-edit://localhost/edited-c'
    ]
    const stop = service.prefetchFitPreviews(sources)
    await vi.waitFor(() => expect(service.cachedFitPreview(sources[2])).toBeDefined())
    expect(loadFrame.mock.calls.map(([source]) => source)).toEqual(sources)
    expect(transport).not.toHaveBeenCalled()
    expect(workers).toHaveLength(0)
    const ready = vi.fn()
    const release = service.subscribeFitPreview(sources[0], ready, vi.fn())
    expect(ready.mock.calls[0][0]).toMatchObject({ image: frames[0].image, width: 4096 })
    stop()
    // 64 MB each: only the frame in use stays once the prefetch set is gone.
    expect(frames[0].release).not.toHaveBeenCalled()
    expect(frames[1].release).toHaveBeenCalledOnce()
    expect(frames[2].release).toHaveBeenCalledOnce()
    release()
    expect(frames[0].release).not.toHaveBeenCalled()
  })

  it('cancels an edited frame load when its viewer leaves and releases late pixels', async () => {
    let finish!: () => void
    const frame = { image: { width: 8, height: 8 }, width: 8, height: 8, release: vi.fn() }
    loadFrame.mockImplementation(() => new Promise((resolve) => (finish = () => resolve(frame))))
    const ready = vi.fn()
    const release = service.subscribeFitPreview('x3f-edit://localhost/leave', ready, vi.fn())
    await settle()
    const signal = loadFrame.mock.calls[0][1] as AbortSignal
    release()
    expect(signal.aborted).toBe(true)
    finish()
    await settle()
    expect(ready).not.toHaveBeenCalled()
    expect(frame.release).toHaveBeenCalledOnce()
    expect(service.cachedFitPreview('x3f-edit://localhost/leave')).toBeUndefined()
  })

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

  it('passes a saved medium through the worker without a second encode', async () => {
    const decoded = { width: 2048, height: 1365, close: vi.fn() }
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => decoded)
    )
    const canvas = vi.fn()
    vi.stubGlobal('OffscreenCanvas', canvas)
    const post = vi.spyOn(self, 'postMessage').mockImplementation(() => {})
    const previous = self.onmessage
    try {
      await import('../src/renderer/src/lib/fitPreview.worker')
      const blob = new Blob(['medium'], { type: 'image/jpeg' })
      const original = { width: 6000, height: 4000 }
      await self.onmessage!({ data: { id: 4, blob, original } } as MessageEvent)
      expect(canvas).not.toHaveBeenCalled()
      expect(post.mock.calls[0][0]).toEqual({ id: 4, blob, image: decoded, ...original })
      expect(decoded.close).not.toHaveBeenCalled()
    } finally {
      self.onmessage = previous
    }
  })

  it('prefetches rendered frames only in the warm set and embedded JPEGs everywhere', async () => {
    loadFrame.mockImplementation(async () => ({
      image: { width: 8, height: 8, close: vi.fn() },
      width: 8,
      height: 8,
      release: vi.fn()
    }))
    const rendered = [0, 1, 2, 3, 4, 5].map((i) => `x3f-edit://localhost/edited-${i}`)
    const stop = service.prefetchFitPreviews([...rendered, 'x3f-preview://localhost/embedded'])
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce())
    expect(loadFrame.mock.calls.map(([source]) => source)).toEqual(rendered.slice(0, 4))
    expect(transport.mock.calls[0][0]).toBe('x3f-preview://localhost/embedded')
    stop()
  })
})
