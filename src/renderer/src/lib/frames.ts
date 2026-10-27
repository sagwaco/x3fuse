import { ipc } from './ipc'

/** Pixels ready to draw. Call release() after drawing. */
export interface Frame {
  image: ImageBitmap
  width: number
  height: number
  release(): void
}

export type ImageRequest = {
  controller: AbortController
  id?: string
  end?: () => Promise<void>
  cancelled?: boolean
  /** Native render priority of an edited preview that must be generated. */
  renderPriority?: RenderPriority
}
export type RenderPriority = 'high' | 'normal' | 'low'

const EDITED = /^(x3f-edit:\/\/|https?:\/\/x3f-edit\.localhost([/:]|$))/i
const EMBEDDED = /^(x3f-preview:\/\/|https?:\/\/x3f-preview\.localhost([/:]|$))/i

export const isEditedFrame = (url: string): boolean => EDITED.test(url)
export const isEmbeddedPreview = (url: string): boolean => EMBEDDED.test(url)
/** Thumbnails stay PNG; only full and region frames load as raw RGBA8. */
const isRaw = (url: string): boolean =>
  isEditedFrame(url) && new URL(url).searchParams.get('v') !== 'thumbnail'
const cancelled = (): DOMException => new DOMException('Cancelled', 'AbortError')
const stopped = (request: ImageRequest): boolean =>
  !!request.cancelled || request.controller.signal.aborted

/** Stored-image lookups are quick, so a few slots serve them apart from generation. */
const LOOKUP_SLOTS = 4
let lookups = 0
const lookupWaiting: Array<() => void> = []

/**
 * Ask the backend for a stored image only, without a RAW decode, a render, or a
 * wait for generation. Resolve undefined on a miss (204) or another failure.
 * A lookup keeps its slot until its body is read. The newest waiting lookup goes
 * first, as the newest visible image does.
 */
export async function fetchCached(
  source: string,
  signal: AbortSignal,
  format?: string
): Promise<Blob | undefined> {
  // A finished lookup gives its slot to a waiter directly, so a new caller cannot take it.
  if (lookups >= LOOKUP_SLOTS) await new Promise<void>((resolve) => lookupWaiting.push(resolve))
  else lookups++
  try {
    if (signal.aborted) throw cancelled()
    const query = `cacheOnly=1${format ? `&format=${format}` : ''}`
    const url = `${source}${source.includes('?') ? '&' : '?'}${query}`
    try {
      const response = await fetch(url, { signal, cache: 'no-store' })
      return response.status === 200 ? await response.blob() : undefined
    } catch (error) {
      if (signal.aborted) throw error
      return undefined
    }
  } finally {
    const next = lookupWaiting.pop()
    if (next) next()
    else lookups--
  }
}

/** Decode a stored image, or resolve undefined on a miss or an unreadable body. */
export async function cachedFrame(url: string, signal: AbortSignal): Promise<Frame | undefined> {
  const raw = isRaw(url)
  const blob = await fetchCached(url, signal, raw ? 'rgba8' : undefined)
  if (!blob) return undefined
  let image: ImageBitmap
  try {
    if (raw) {
      const pixels = parseFrame(await blob.arrayBuffer())
      if (!pixels) return undefined
      image = await (pixels instanceof Blob ? createImageBitmap(pixels) : bitmap(pixels))
    } else {
      // Small embedded previews carry no orientation; the viewer applies the EXIF value.
      image = await (isEditedFrame(url)
        ? createImageBitmap(blob)
        : createImageBitmap(blob, { imageOrientation: 'none' }))
    }
  } catch (error) {
    if (signal.aborted) throw error
    return undefined
  }
  if (signal.aborted) {
    image.close()
    throw cancelled()
  }
  return ownedFrame(image)
}

/** Edited previews register one native request ID; later fetches of the request reuse it. */
export async function fetchPreview(
  source: string,
  request: ImageRequest,
  format?: string
): Promise<Response> {
  let url = source
  if (isEditedFrame(url)) {
    if (!request.end) {
      const { requestId } = await ipc.invoke('editor:beginImageRequest')
      let ending: Promise<void> | undefined
      request.id = requestId
      request.end = () => (ending ??= ipc.invoke('editor:endImageRequest', { requestId }))
    }
    const uri = new URL(url)
    uri.searchParams.set('requestId', request.id!)
    if (format) uri.searchParams.set('format', format)
    if (request.renderPriority) uri.searchParams.set('priority', request.renderPriority)
    url = uri.toString()
  }
  if (stopped(request)) throw cancelled()
  return fetch(url, { signal: request.controller.signal })
}

export function cancelPreview(source: string, request: ImageRequest): void {
  // Embedded JPEG extraction cannot be cancelled; keep its native concurrency bounded.
  if (isEmbeddedPreview(source)) return
  request.cancelled = true
  if (request.end) {
    // Wait for native cancellation acknowledgement before freeing a transport slot.
    void request.end().then(
      () => request.controller.abort(),
      () => {}
    )
  } else request.controller.abort()
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Read a raw `X3F8` body: magic, then width, height and 0 as little-endian u32, then RGBA8.
 * A frame that exists only as a PNG on disk can come back as that PNG; return it to decode.
 */
export function parseFrame(body: ArrayBuffer): ImageData | Blob | undefined {
  const start = new Uint8Array(body, 0, Math.min(8, body.byteLength))
  if (PNG.every((byte, i) => start[i] === byte)) return new Blob([body], { type: 'image/png' })
  if (body.byteLength < 16) return undefined
  const header = new DataView(body, 0, 16)
  const magic = String.fromCharCode(...new Uint8Array(body, 0, 4))
  const width = header.getUint32(4, true)
  const height = header.getUint32(8, true)
  if (magic !== 'X3F8' || !width || !height || body.byteLength !== 16 + width * height * 4)
    return undefined
  return new ImageData(new Uint8ClampedArray(body, 16), width, height)
}

/** A frame that owns its bitmap and closes it on release. */
export const ownedFrame = (image: ImageBitmap): Frame => ({
  image,
  width: image.width,
  height: image.height,
  release: () => image.close()
})

type Waiting = { resolve: (image: ImageBitmap) => void; reject: (error: Error) => void }
let frameWorker: Worker | null | undefined
let frameId = 0
const waiting = new Map<number, Waiting>()

/** The worker that makes bitmaps, or null when the main thread must make them. */
function bitmapWorker(): Worker | null {
  if (frameWorker !== undefined) return frameWorker
  let worker: Worker
  try {
    worker = new Worker(new URL('./frame.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return (frameWorker = null)
  }
  worker.onmessage = ({ data }: MessageEvent<{ id: number; image?: ImageBitmap }>) => {
    const request = waiting.get(data.id)
    waiting.delete(data.id)
    if (data.image) request?.resolve(data.image)
    else request?.reject(new Error('No bitmap'))
  }
  // A reply that cannot arrive fails every request, as a worker error does.
  worker.onerror = worker.onmessageerror = () => {
    worker.terminate()
    frameWorker = null
    for (const request of waiting.values()) request.reject(new Error('Frame worker failed'))
    waiting.clear()
  }
  return (frameWorker = worker)
}

/**
 * Make a bitmap from raw pixels. A worker copies them, and the main thread
 * only moves the buffer, so animations keep their frame rate.
 */
function bitmap(pixels: ImageData): Promise<ImageBitmap> {
  const worker = bitmapWorker()
  if (!worker) return createImageBitmap(pixels)
  const { buffer, byteOffset } = pixels.data
  const { width, height } = pixels
  return new Promise((resolve, reject) => {
    const id = ++frameId
    waiting.set(id, { resolve, reject })
    try {
      worker.postMessage({ id, buffer, byteOffset, width, height }, [buffer])
    } catch (error) {
      waiting.delete(id)
      reject(error)
    }
  })
}

async function decode(response: Response): Promise<ImageBitmap> {
  if (!response.ok) throw new Error(`preview ${response.status}`)
  return createImageBitmap(await response.blob())
}

/**
 * Open a frame for a request that the caller ends. Edited previews load as raw
 * RGBA8 without a decode. An OK body that is neither a frame nor a PNG (an older
 * backend) makes one more request for the PNG.
 */
export async function openFrame(url: string, request: ImageRequest): Promise<Frame> {
  if (!isRaw(url)) return ownedFrame(await decode(await fetchPreview(url, request)))
  const response = await fetchPreview(url, request, 'rgba8')
  if (!response.ok) throw new Error(`preview ${response.status}`)
  const body = await response.arrayBuffer()
  if (stopped(request)) throw cancelled()
  let image: ImageBitmap
  try {
    const pixels = parseFrame(body)
    if (!pixels) throw new Error('Not a frame')
    image = await (pixels instanceof Blob ? createImageBitmap(pixels) : bitmap(pixels))
  } catch (error) {
    if (stopped(request)) throw error
    image = await decode(await fetchPreview(url, request))
  }
  if (stopped(request)) {
    image.close()
    throw cancelled()
  }
  return ownedFrame(image)
}

/** Edited-preview URLs load as raw RGBA8; other URLs decode. */
export function loadFrame(
  url: string,
  signal?: AbortSignal,
  priority?: RenderPriority
): Promise<Frame> {
  if (signal?.aborted) return Promise.reject(cancelled())
  const request: ImageRequest = { controller: new AbortController(), renderPriority: priority }
  const abort = (): void => cancelPreview(url, request)
  signal?.addEventListener('abort', abort, { once: true })
  return openFrame(url, request)
    .then((frame) => {
      if (!signal?.aborted) return frame
      frame.release()
      throw cancelled()
    })
    .finally(() => {
      signal?.removeEventListener('abort', abort)
      void request.end?.().catch(() => {})
    })
}
