// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cachedScope,
  createScopeRenderer,
  scopeRenderKey
} from '../src/renderer/src/lib/scopeRender'
import { drawScope, type ScopeRenderRequest } from '../src/renderer/src/lib/scopeRenderer'

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

/** One mock serves the scope canvas and the per-channel layer canvases it splats into. */
function canvasContext() {
  const context = {
    scale: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fillText: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
    strokeRect: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
    createImageData: vi.fn((width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4)
    }))
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  )
  return context
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

  it('separates image identity, mode, width, pixel ratio and theme in completed cache keys', () => {
    const source = request()
    const key = scopeRenderKey(source)
    expect(scopeRenderKey({ ...source })).toBe(key)
    expect(scopeRenderKey({ ...source, theme: 'dark' })).toBe(key)
    for (const changed of [
      request(),
      { ...source, mode: 'histogram' as const },
      { ...source, width: 300 },
      { ...source, pixelRatio: 1 },
      { ...source, theme: 'light' as const }
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
    const context = canvasContext()
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
    expect(context.putImageData).toHaveBeenCalled()
    expect(context.arc).not.toHaveBeenCalled()
    renderer.dispose()
  })
})

describe('scope trace resolution', () => {
  it.each([1, 1.5, 2])('splats density bins at %sx device resolution', (pixelRatio) => {
    for (const mode of ['waveform', 'rgbParade', 'vectorscope'] as const) {
      const context = canvasContext()
      const image = {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([255, 255, 255, 255])
      } as ImageData
      const steps = drawScope(context as unknown as CanvasRenderingContext2D, {
        ...request(),
        image,
        mode,
        pixelRatio
      })
      while (!steps.next().done) {
        /* Drain the shared worker/fallback renderer. */
      }
      // Each layer is put into its own canvas, then drawn at one layer pixel per device pixel.
      const layers = context.putImageData.mock.calls.map(([pixels], i) => {
        const [, x, y, width, height] = context.drawImage.mock.calls[i]
        expect(width * pixelRatio).toBeCloseTo(pixels.width)
        expect(height * pixelRatio).toBeCloseTo(pixels.height)
        const lit = [...Array(pixels.width * pixels.height).keys()].filter(
          (p) => pixels.data[p * 4 + 3] > 0
        )
        return { pixels, x, y, lit }
      })
      expect(layers).toHaveLength(mode === 'vectorscope' ? 1 : mode === 'waveform' ? 4 : 3)
      if (mode === 'vectorscope') {
        const [{ pixels, x, y }] = layers
        const peak = pixels.data.reduce(
          (best: number, value: number, i: number) =>
            i % 4 === 3 && value > pixels.data[best * 4 + 3] ? i >> 2 : best,
          0
        )
        // A neutral trace aligns with the center of the graticule to half a device pixel.
        const circle = context.arc.mock.calls.at(-1)!
        const px = x + ((peak % pixels.width) + 0.5) / pixelRatio
        const py = y + (Math.floor(peak / pixels.width) + 0.5) / pixelRatio
        expect(Math.abs(px - circle[0])).toBeLessThanOrEqual(0.5 / pixelRatio + 1e-8)
        expect(Math.abs(py - circle[1])).toBeLessThanOrEqual(0.5 / pixelRatio + 1e-8)
      } else {
        const columns = mode === 'waveform' ? 230 : 73
        for (const [c, { pixels, x, y, lit }] of layers.entries()) {
          expect(pixels.width).toBe(Math.round(columns * pixelRatio))
          expect(x).toBe(36 + (mode === 'rgbParade' ? c * (columns + 5) : 0))
          expect(y).toBe(15)
          // White fills every device column, starting at the 100% row.
          expect(new Set(lit.map((p) => p % pixels.width)).size).toBe(pixels.width)
          expect(Math.min(...lit.map((p) => Math.floor(p / pixels.width)))).toBe(0)
        }
      }
    }
  })
})
