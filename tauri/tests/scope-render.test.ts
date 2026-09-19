// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cachedScope,
  createScopeRenderer,
  scopeRenderKey
} from '../src/renderer/src/lib/scopeRender'
import type { ScopeRenderRequest } from '../src/renderer/src/lib/scopeRenderer'

const workers: FakeWorker[] = []
class FakeWorker {
  onmessage?: (event: MessageEvent) => void
  onerror?: (event: ErrorEvent) => void
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() {
    workers.push(this)
  }
  reply(bitmap?: ImageBitmap, failed = false): void {
    const { id } = this.postMessage.mock.calls.at(-1)![0]
    this.onmessage?.({ data: { id, bitmap, failed } } as MessageEvent)
  }
}

function request(): ScopeRenderRequest {
  return {
    image: {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255])
    } as ImageData,
    mode: 'waveform',
    width: 274,
    pixelRatio: 2
  }
}

function bitmap(width = 548, height = 400): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap
}

beforeEach(() => {
  workers.length = 0
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('scope rendering scheduler', () => {
  it('runs only A then C when selections A, B, C arrive rapidly and closes obsolete output', () => {
    const renderer = createScopeRenderer()
    const a = request(),
      b = request(),
      c = request()
    const first = vi.fn(),
      second = vi.fn(),
      latest = vi.fn(),
      failed = vi.fn()
    renderer.render(a, first, failed)
    renderer.render(b, second, failed)
    renderer.render(c, latest, failed)
    expect(workers).toHaveLength(1)
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1)
    const stale = bitmap()
    workers[0].reply(stale)
    expect(stale.close).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2)
    expect(workers[0].postMessage.mock.calls[1][0].image).toBe(c.image)
    const result = bitmap()
    workers[0].reply(result)
    expect(latest).toHaveBeenCalledWith(result)
    expect(failed).not.toHaveBeenCalled()
    expect(cachedScope(scopeRenderKey(a))).toBeUndefined()
    const revisit = vi.fn()
    renderer.render(c, revisit, failed)
    expect(revisit).toHaveBeenCalledWith(result)
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2)
    renderer.dispose()
  })

  it('separates image identity, mode, width and pixel ratio in completed cache keys', () => {
    const source = request()
    const key = scopeRenderKey(source)
    expect(scopeRenderKey({ ...source })).toBe(key)
    for (const changed of [
      request(),
      { ...source, mode: 'histogram' as const },
      { ...source, width: 300 },
      { ...source, pixelRatio: 1 }
    ])
      expect(scopeRenderKey(changed)).not.toBe(key)
  })

  it('bounds completed output to 16 MiB, retains recent hits, and releases evicted bitmaps', () => {
    const renderer = createScopeRenderer()
    const requests = Array.from({ length: 5 }, request)
    const outputs = requests.map(() => bitmap(1024, 1024))
    const complete = vi.fn(),
      failed = vi.fn()
    for (let i = 0; i < requests.length; i++) {
      renderer.render(requests[i], complete, failed)
      workers[0].reply(outputs[i])
      if (i === 2) expect(cachedScope(scopeRenderKey(requests[0]))).toBe(outputs[0])
    }
    expect(outputs[1].close).toHaveBeenCalledOnce()
    expect(outputs[0].close).not.toHaveBeenCalled()
    expect(cachedScope(scopeRenderKey(requests[1]))).toBeUndefined()
    expect(cachedScope(scopeRenderKey(requests[4]))).toBe(outputs[4])
    renderer.dispose()
  })

  it('closes cancelled and late bitmaps without painting after unmount', () => {
    const renderer = createScopeRenderer()
    const complete = vi.fn()
    const cancel = renderer.render(request(), complete, vi.fn())
    cancel()
    const cancelled = bitmap()
    workers[0].reply(cancelled)
    expect(cancelled.close).toHaveBeenCalledOnce()
    renderer.render(request(), complete, vi.fn())
    renderer.dispose()
    const late = bitmap()
    workers[0].reply(late)
    expect(late.close).toHaveBeenCalledOnce()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()
  })

  it('renders in cancellable slices when offscreen worker rendering is unavailable', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock++)
    const context = {
      scale: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fillText: vi.fn(),
      fill: vi.fn()
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    )
    const renderer = createScopeRenderer()
    const old = vi.fn(),
      latest = vi.fn(),
      failed = vi.fn()
    const cancel = renderer.render(request(), old, failed)
    workers[0].reply(undefined, true)
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(context.stroke).not.toHaveBeenCalled()
    vi.advanceTimersToNextTimer()
    expect(context.stroke).toHaveBeenCalled()
    expect(old).not.toHaveBeenCalled()
    cancel()
    renderer.render(request(), latest, failed)
    vi.runAllTimers()
    expect(old).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledOnce()
    expect(latest.mock.calls[0][0]).toBeInstanceOf(HTMLCanvasElement)
    expect(failed).not.toHaveBeenCalled()
    expect(context.arc).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      0.75,
      0,
      Math.PI * 2
    )
    renderer.dispose()
  })
})
