// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))
let frames: typeof import('../src/renderer/src/lib/frames')

function body(width: number, height: number, magic = 'X3F8', extra = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + width * height * 4 + extra)
  new Uint8Array(buffer).set([...magic].map((c) => c.charCodeAt(0)))
  new DataView(buffer).setUint32(4, width, true)
  new DataView(buffer).setUint32(8, height, true)
  return buffer
}
const raw = (buffer: ArrayBuffer) =>
  ({ ok: true, arrayBuffer: async () => buffer, blob: async () => new Blob() }) as Response
const png = () => ({ ok: true, blob: async () => new Blob(['png']) }) as Response
const bitmap = (width = 4096, height = 4096) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap

beforeEach(async () => {
  vi.resetModules()
  let serial = 0
  invoke
    .mockReset()
    .mockImplementation(async (channel) =>
      channel === 'editor:beginImageRequest' ? { requestId: `request-${serial++}` } : undefined
    )
  vi.stubGlobal('fetch', vi.fn())
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (source: { width?: number; height?: number }) =>
      bitmap(source.width ?? 640, source.height ?? 480)
    )
  )
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
  frames = await import('../src/renderer/src/lib/frames')
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const PNG_BODY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const formatOf = (call: number): string | null =>
  new URL(String(vi.mocked(fetch).mock.calls[call][0])).searchParams.get('format')

it('parses only complete X3F8 bodies as a view of the pixels after the header', () => {
  const buffer = body(3, 2)
  new Uint8Array(buffer, 16).forEach((_, i, pixels) => (pixels[i] = i))
  const pixels = frames.parseFrame(buffer) as ImageData
  expect([pixels.width, pixels.height]).toEqual([3, 2])
  // No copy: the pixels are the response bytes after the 16-byte header.
  expect(pixels.data).toBeInstanceOf(Uint8ClampedArray)
  expect([pixels.data.buffer, pixels.data.byteOffset, pixels.data.length]).toEqual([buffer, 16, 24])
  expect([pixels.data[0], pixels.data[23]]).toEqual([0, 23])
  expect(frames.parseFrame(body(3, 2, 'X3FS'))).toBeUndefined()
  expect(frames.parseFrame(body(3, 2, 'X3F8', 1))).toBeUndefined()
  expect(frames.parseFrame(body(3, 2).slice(0, 30))).toBeUndefined()
  expect(frames.parseFrame(body(0, 2))).toBeUndefined()
  expect(frames.parseFrame(new ArrayBuffer(8))).toBeUndefined()
  expect(frames.parseFrame(new ArrayBuffer(0))).toBeUndefined()
  const png = frames.parseFrame(PNG_BODY.slice().buffer) as Blob
  expect([png instanceof Blob, png.type, png.size]).toEqual([true, 'image/png', 11])
  expect(frames.parseFrame(PNG_BODY.slice(0, 7).buffer)).toBeUndefined()
})

it('loads edited previews as raw RGBA8 under one native request', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(raw(body(2, 1)))
  const frame = await frames.loadFrame('x3f-edit://localhost/abc?requestId=stale')
  expect([frame.width, frame.height]).toEqual([2, 1])
  const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]))
  expect(url.searchParams.get('format')).toBe('rgba8')
  expect(url.searchParams.get('requestId')).toBe('request-0')
  expect(createImageBitmap).toHaveBeenCalledWith(expect.objectContaining({ width: 2 }))
  expect(invoke).toHaveBeenLastCalledWith('editor:endImageRequest', { requestId: 'request-0' })
  frame.release()
  expect(frame.image.close).toHaveBeenCalledOnce()
})

/** A frame worker that answers each request, or fails like a worker that cannot load. */
function stubWorker(answer: (message: Record<string, unknown>) => unknown): {
  posted: Array<{ message: Record<string, unknown>; transfer: Transferable[] }>
} {
  const posted: Array<{ message: Record<string, unknown>; transfer: Transferable[] }> = []
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror: (() => void) | null = null
      postMessage(message: Record<string, unknown>, transfer: Transferable[]): void {
        posted.push({ message, transfer })
        const data = answer(message)
        queueMicrotask(() => (data ? this.onmessage?.({ data }) : this.onerror?.()))
      }
      terminate(): void {}
    }
  )
  return { posted }
}

it('makes the bitmap of a raw frame in a worker and moves the pixels there', async () => {
  const image = bitmap(2, 1)
  const { posted } = stubWorker((message) => ({ id: message.id, image }))
  vi.mocked(fetch).mockResolvedValueOnce(raw(body(2, 1)))
  const frame = await frames.loadFrame('x3f-edit://localhost/abc')
  expect(frame.image).toBe(image)
  expect(createImageBitmap).not.toHaveBeenCalled()
  expect(posted[0].message).toMatchObject({ width: 2, height: 1, byteOffset: 16 })
  expect(posted[0].transfer).toEqual([posted[0].message.buffer])
})

it('makes bitmaps on the main thread after the worker fails', async () => {
  stubWorker(() => undefined)
  vi.mocked(fetch)
    .mockResolvedValueOnce(raw(body(2, 1)))
    .mockResolvedValueOnce(png())
    .mockResolvedValueOnce(raw(body(2, 1)))
  // The failed request loads the PNG instead.
  expect((await frames.loadFrame('x3f-edit://localhost/abc')).width).toBe(640)
  expect(createImageBitmap).toHaveBeenLastCalledWith(expect.any(Blob))
  expect((await frames.loadFrame('x3f-edit://localhost/def')).width).toBe(2)
  expect(createImageBitmap).toHaveBeenLastCalledWith(expect.objectContaining({ width: 2 }))
})

it('makes bitmaps on the main thread when the worker cannot start', async () => {
  const started = vi.fn(() => {
    throw new DOMException('Blocked', 'SecurityError')
  })
  vi.stubGlobal('Worker', started)
  vi.mocked(fetch)
    .mockResolvedValueOnce(raw(body(2, 1)))
    .mockResolvedValueOnce(raw(body(2, 1)))
  expect((await frames.loadFrame('x3f-edit://localhost/abc')).width).toBe(2)
  expect((await frames.loadFrame('x3f-edit://localhost/def')).width).toBe(2)
  expect(started).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('decodes a PNG body from the raw request without a second request', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(raw(PNG_BODY.slice().buffer))
  const frame = await frames.loadFrame('http://x3f-edit.localhost/disk')
  expect(frame.width).toBe(640)
  expect(fetch).toHaveBeenCalledOnce()
  expect(formatOf(0)).toBe('rgba8')
  expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob))
})

it('loads thumbnails as PNG without a raw request', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(png())
  await frames.loadFrame('http://x3f-edit.localhost/abc?v=thumbnail')
  expect(fetch).toHaveBeenCalledOnce()
  expect(formatOf(0)).toBeNull()
})

it('falls back to the PNG once with the same request only for an OK body that is not a frame', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(raw(body(2, 1, 'GIF8')))
    .mockResolvedValueOnce(png())
  const frame = await frames.loadFrame('http://x3f-edit.localhost/abc')
  expect(frame.width).toBe(640)
  const [first, second] = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)))
  expect(second.searchParams.has('format')).toBe(false)
  expect(second.searchParams.get('requestId')).toBe(first.searchParams.get('requestId'))
  expect(invoke.mock.calls.filter(([channel]) => channel.startsWith('editor:'))).toHaveLength(2)
})

it('rejects a failed status or a network error without a second request', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response)
  await expect(frames.loadFrame('x3f-edit://localhost/gone')).rejects.toThrow('preview 404')
  expect(fetch).toHaveBeenCalledOnce()
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Load failed'))
  await expect(frames.loadFrame('x3f-edit://localhost/offline')).rejects.toThrow('Load failed')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(invoke).toHaveBeenLastCalledWith('editor:endImageRequest', { requestId: 'request-1' })
})

it('loads the PNG once when the raw pixels do not make a bitmap', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(raw(body(2, 1)))
    .mockResolvedValueOnce(png())
  vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('No bitmap'))
  expect((await frames.loadFrame('x3f-edit://localhost/abc')).width).toBe(640)
  expect(formatOf(1)).toBeNull()
  vi.mocked(fetch)
    .mockResolvedValueOnce(raw(body(2, 1)))
    .mockResolvedValueOnce(png())
  vi.mocked(createImageBitmap)
    .mockRejectedValueOnce(new Error('No bitmap'))
    .mockRejectedValueOnce(new Error('Bad PNG'))
  await expect(frames.loadFrame('x3f-edit://localhost/abc')).rejects.toThrow('Bad PNG')
  expect(fetch).toHaveBeenCalledTimes(4)
})

it('closes a bitmap that arrives after an abort', async () => {
  let finish!: (image: ImageBitmap) => void
  vi.mocked(createImageBitmap).mockImplementationOnce(
    () => new Promise<ImageBitmap>((resolve) => (finish = resolve))
  )
  vi.mocked(fetch).mockResolvedValueOnce(raw(body(2, 1)))
  const controller = new AbortController()
  const result = frames.loadFrame('x3f-edit://localhost/abc', controller.signal)
  await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledOnce())
  controller.abort()
  const late = bitmap(2, 1)
  finish(late)
  await expect(result).rejects.toThrow('Cancelled')
  expect(late.close).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledOnce()
})

it('ends the native request before it aborts the fetch and never falls back', async () => {
  let acknowledge!: () => void
  invoke.mockImplementation((channel) =>
    channel === 'editor:beginImageRequest'
      ? Promise.resolve({ requestId: 'cancel' })
      : new Promise<void>((resolve) => (acknowledge = resolve))
  )
  vi.mocked(fetch).mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options!.signal!.addEventListener('abort', () =>
          reject(new DOMException('Cancelled', 'AbortError'))
        )
      )
  )
  const controller = new AbortController()
  const result = frames.loadFrame('x3f-edit://localhost/abc', controller.signal)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  controller.abort()
  expect(invoke).toHaveBeenLastCalledWith('editor:endImageRequest', { requestId: 'cancel' })
  expect(vi.mocked(fetch).mock.calls[0][1]!.signal!.aborted).toBe(false)
  acknowledge()
  await expect(result).rejects.toThrow('Cancelled')
  expect(fetch).toHaveBeenCalledOnce()
  await expect(frames.loadFrame('x3f-edit://localhost/abc', controller.signal)).rejects.toThrow(
    'Cancelled'
  )
})
