import { drawImageWithOrientation } from './orientation'

const SMALL_BUDGET = 16 * 1024 * 1024
const FULL_BUDGET = 64 * 1024 * 1024
const small = new Map<string, HTMLCanvasElement>()
let smallBytes = 0
type SmallJob = {
  key: string
  url: string
  orientation: number
  aspectRatio?: number
  consumers: Set<{
    signal: AbortSignal
    resolve: (canvas: HTMLCanvasElement) => void
    reject: (error: unknown) => void
  }>
}
const smallJobs = new Map<string, SmallJob>()
const smallQueue: SmallJob[] = []
let smallRunning = 0

export const smallPreviewKey = (url: string, orientation = 1, aspectRatio?: number): string =>
  JSON.stringify([url, orientation, aspectRatio])

export function cachedSmallPreview(
  url: string,
  orientation = 1,
  aspectRatio?: number
): HTMLCanvasElement | undefined {
  const key = smallPreviewKey(url, orientation, aspectRatio)
  const canvas = small.get(key)
  if (canvas) {
    small.delete(key)
    small.set(key, canvas)
  }
  return canvas
}

function pumpSmall(): void {
  while (smallRunning < 3 && smallQueue.length) {
    const job = smallQueue.shift()!
    if (!job.consumers.size) {
      smallJobs.delete(job.key)
      continue
    }
    smallRunning++
    void (async () => {
      try {
        const response = await fetch(job.url)
        if (!response.ok) throw new Error(`preview ${response.status}`)
        const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: 'none' })
        const canvas = document.createElement('canvas')
        try {
          if (!canvas.getContext('2d')) throw new Error('No preview canvas')
          drawImageWithOrientation(canvas, bitmap, job.orientation, {
            aspectRatio: job.aspectRatio
          })
        } finally {
          bitmap.close()
        }
        small.set(job.key, canvas)
        smallBytes += canvas.width * canvas.height * 4
        while (smallBytes > SMALL_BUDGET && small.size) {
          const [key, oldest] = small.entries().next().value!
          small.delete(key)
          smallBytes -= oldest.width * oldest.height * 4
        }
        for (const consumer of job.consumers) consumer.resolve(canvas)
      } catch (error) {
        for (const consumer of job.consumers) consumer.reject(error)
      } finally {
        smallJobs.delete(job.key)
        smallRunning--
        pumpSmall()
      }
    })()
  }
}

/** Consumers cancel independently; a running native extraction retains its slot until completion. */
export function loadSmallPreview(
  url: string,
  orientation: number,
  aspectRatio: number | undefined,
  signal: AbortSignal
): Promise<HTMLCanvasElement> {
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
  const cached = cachedSmallPreview(url, orientation, aspectRatio)
  if (cached) return Promise.resolve(cached)
  const key = smallPreviewKey(url, orientation, aspectRatio)
  let job = smallJobs.get(key)
  if (!job) {
    job = { key, url, orientation, aspectRatio, consumers: new Set() }
    smallJobs.set(key, job)
    smallQueue.push(job)
  }
  const current = job
  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    const abort = (): void => {
      current.consumers.delete(consumer)
      if (!current.consumers.size) {
        const queued = smallQueue.indexOf(current)
        if (queued >= 0) {
          smallQueue.splice(queued, 1)
          smallJobs.delete(current.key)
        }
      }
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const consumer = {
      signal,
      resolve: (canvas: HTMLCanvasElement): void => {
        signal.removeEventListener('abort', abort)
        resolve(canvas)
      },
      reject: (error: unknown): void => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    }
    current.consumers.add(consumer)
    signal.addEventListener('abort', abort, { once: true })
    // StrictMode may release/reacquire a consumer before this microtask runs.
    queueMicrotask(pumpSmall)
  })
}

type FullEntry = { url: string; blob: Blob; bytes: number; users: number }
type FullConsumer = { ready: (entry: FullEntry) => void; error: () => void }
type FullJob = { source: string; consumers: Set<FullConsumer> }
const full = new Map<string, FullEntry>()
let fullBytes = 0
let running: FullJob | undefined
let pending: FullJob | undefined
let background: FullJob | undefined

function trimFull(): void {
  for (const [source, entry] of full) {
    if (fullBytes <= FULL_BUDGET) break
    if (entry.users) continue
    full.delete(source)
    fullBytes -= entry.bytes
    URL.revokeObjectURL(entry.url)
  }
}

export function cachedFullPreview(source: string): string | undefined {
  const entry = full.get(source)
  if (entry) {
    full.delete(source)
    full.set(source, entry)
  }
  return entry?.url
}

function pumpFull(): void {
  if (running) return
  const job = pending ?? background
  if (!pending) background = undefined
  pending = undefined
  if (!job) return
  const current = job
  running = current
  void (async () => {
    try {
      const response = await fetch(current.source)
      if (!response.ok) throw new Error(`preview ${response.status}`)
      const blob = await response.blob()
      const entry = { url: URL.createObjectURL(blob), blob, bytes: blob.size, users: 0 }
      full.set(current.source, entry)
      fullBytes += entry.bytes
      for (const consumer of current.consumers) consumer.ready(entry)
      trimFull()
    } catch {
      for (const consumer of current.consumers) consumer.error()
    } finally {
      running = undefined
      pumpFull()
    }
  })()
}

/** One full extraction in flight, one latest foreground request; no navigation backlog. */
export function subscribeFullPreview(
  source: string,
  ready: (url: string) => void,
  error: () => void,
  priority: 'foreground' | 'background' = 'foreground'
): () => void {
  let held: FullEntry | undefined
  let released = false
  const consumer: FullConsumer = {
    ready: (entry) => {
      if (released) return
      held = entry
      entry.users++
      ready(entry.url)
    },
    error
  }
  const cached = full.get(source)
  let job: FullJob | undefined
  if (cached) {
    cachedFullPreview(source)
    consumer.ready(cached)
  } else {
    job =
      running?.source === source
        ? running
        : pending?.source === source
          ? pending
          : background?.source === source
            ? background
            : undefined
    if (!job) {
      job = { source, consumers: new Set() }
      if (priority === 'foreground') {
        if (pending) for (const old of pending.consumers) old.error()
        pending = job
      } else {
        if (background) for (const old of background.consumers) old.error()
        background = job
      }
    } else if (job === background && priority === 'foreground') {
      background = undefined
      if (pending) for (const old of pending.consumers) old.error()
      pending = job
    }
    job.consumers.add(consumer)
    queueMicrotask(pumpFull)
  }
  return () => {
    if (released) return
    released = true
    job?.consumers.delete(consumer)
    if (pending === job && !job?.consumers.size) pending = undefined
    if (background === job && !job?.consumers.size) background = undefined
    if (held) held.users--
    // Let a remounted viewer acquire the same URL before evicting an unpinned entry.
    queueMicrotask(trimFull)
  }
}

/** Share the transport's original bytes with the fit-image worker, without another fetch. */
export function subscribeFullPreviewBlob(
  source: string,
  ready: (blob: Blob) => void,
  error: () => void,
  priority: 'foreground' | 'background' = 'foreground'
): () => void {
  return subscribeFullPreview(source, () => ready(full.get(source)!.blob), error, priority)
}
