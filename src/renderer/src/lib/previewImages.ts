import { drawImageWithOrientation } from './orientation'
import {
  cachedFrame,
  cancelPreview,
  fetchCached,
  fetchPreview,
  isEditedFrame,
  isEmbeddedPreview,
  openFrame,
  ownedFrame,
  type Frame,
  type ImageRequest
} from './frames'
import { forget, getHeld, hold, memoryEpoch, unhold, type Held } from './memoryCache'

/** The photo that the user works on goes before the visible thumbnails. */
export type SmallPriority = 'selected' | 'visible'
/** Stored images bypass these slots; only generation waits for them. */
const SMALL_SLOTS = 3
type SmallConsumer = {
  signal: AbortSignal
  resolve: (canvas: HTMLCanvasElement) => void
  reject: (error: unknown) => void
}
type SmallJob = ImageRequest & {
  key: string
  url: string
  orientation: number
  aspectRatio?: number
  priority: SmallPriority
  stage: 'lookup' | 'queued' | 'running'
  /** The Clear count when the job started. */
  epoch: number
  lookup: AbortController
  consumers: Set<SmallConsumer>
}
const smallJobs = new Map<string, SmallJob>()
const smallQueue: SmallJob[] = []
let smallRunning = 0
const idleListeners = new Set<() => void>()

export const smallPreviewKey = (url: string, orientation = 1, aspectRatio?: number): string =>
  JSON.stringify([url, orientation, aspectRatio])
const smallMemoryKey = (key: string): string => `small:${key}`

export function cachedSmallPreview(
  url: string,
  orientation = 1,
  aspectRatio?: number
): HTMLCanvasElement | undefined {
  return getHeld<HTMLCanvasElement>(smallMemoryKey(smallPreviewKey(url, orientation, aspectRatio)))
    ?.value
}

/** True while no thumbnail waits for a lookup or for generation. */
export const thumbnailsIdle = (): boolean => !smallJobs.size && !smallRunning

/** Call `listener` once when thumbnails are idle. Returns a function that cancels the call. */
export function whenThumbnailsIdle(listener: () => void): () => void {
  if (thumbnailsIdle()) {
    listener()
    return () => {}
  }
  const once = (): void => {
    idleListeners.delete(once)
    listener()
  }
  idleListeners.add(once)
  return () => idleListeners.delete(once)
}

function endSmall(job: SmallJob): void {
  if (smallJobs.get(job.key) === job) smallJobs.delete(job.key)
  pumpSmall()
}

function pumpSmall(): void {
  while (smallRunning < SMALL_SLOTS && smallQueue.length) {
    const job = smallQueue.shift()!
    if (!job.consumers.size) {
      if (smallJobs.get(job.key) === job) smallJobs.delete(job.key)
      continue
    }
    job.stage = 'running'
    job.renderPriority = job.priority === 'selected' ? 'high' : 'normal'
    smallRunning++
    void (async () => {
      try {
        let frame: Frame
        // Edited frames need no decode.
        if (isEditedFrame(job.url)) frame = await openFrame(job.url, job)
        else {
          const response = await fetchPreview(job.url, job)
          if (!job.consumers.size) return
          if (!response.ok) throw new Error(`preview ${response.status}`)
          const blob = await response.blob()
          if (!job.consumers.size) return
          frame = ownedFrame(await createImageBitmap(blob, { imageOrientation: 'none' }))
        }
        deliverSmall(job, frame)
      } catch (error) {
        for (const consumer of job.consumers) consumer.reject(error)
      } finally {
        if (smallJobs.get(job.key) === job) smallJobs.delete(job.key)
        await job.end?.().catch(() => {})
        smallRunning--
        pumpSmall()
      }
    })()
  }
  if (thumbnailsIdle()) [...idleListeners].forEach((listener) => listener())
}

function deliverSmall(job: SmallJob, frame: Frame): void {
  const canvas = document.createElement('canvas')
  try {
    if (!job.consumers.size) return
    if (!canvas.getContext('2d')) throw new Error('No preview canvas')
    drawImageWithOrientation(canvas, frame.image, job.orientation, {
      maxEdge: 640,
      aspectRatio: job.aspectRatio
    })
  } finally {
    frame.release()
  }
  const entry = hold(
    smallMemoryKey(job.key),
    canvas,
    canvas.width * canvas.height * 4,
    undefined,
    job.epoch
  )
  for (const consumer of job.consumers) consumer.resolve(entry.value)
}

/** The selected photo goes first; within a priority, the newest request goes first. */
function enqueueSmall(job: SmallJob): void {
  const queued = smallQueue.indexOf(job)
  if (queued >= 0) smallQueue.splice(queued, 1)
  const index =
    job.priority === 'selected' ? 0 : smallQueue.findIndex((other) => other.priority !== 'selected')
  smallQueue.splice(index < 0 ? smallQueue.length : index, 0, job)
}

async function lookupSmall(job: SmallJob): Promise<void> {
  let frame: Frame | undefined
  try {
    frame = await cachedFrame(job.url, job.lookup.signal)
  } catch {
    // An abandoned lookup has no consumers; the check below ends it.
  }
  if (!job.consumers.size) {
    frame?.release()
    return endSmall(job)
  }
  if (frame) {
    try {
      deliverSmall(job, frame)
    } catch (error) {
      for (const consumer of job.consumers) consumer.reject(error)
    }
    return endSmall(job)
  }
  job.stage = 'queued'
  enqueueSmall(job)
  pumpSmall()
}

/**
 * Stored thumbnails load at once through the lookup lane. Misses wait for one of
 * three generation slots: the selected photo first, then the newest visible
 * thumbnail. Shared consumers cancel independently.
 */
export function loadSmallPreview(
  url: string,
  orientation: number,
  aspectRatio: number | undefined,
  signal: AbortSignal,
  priority: SmallPriority = 'visible'
): Promise<HTMLCanvasElement> {
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
  const cached = cachedSmallPreview(url, orientation, aspectRatio)
  if (cached) return Promise.resolve(cached)
  const key = smallPreviewKey(url, orientation, aspectRatio)
  let job = smallJobs.get(key)
  if (!job) {
    const created: SmallJob = {
      key,
      url,
      orientation,
      aspectRatio,
      priority,
      stage: 'lookup',
      epoch: memoryEpoch(),
      lookup: new AbortController(),
      controller: new AbortController(),
      consumers: new Set()
    }
    job = created
    smallJobs.set(key, created)
    // StrictMode may release/reacquire a consumer before this microtask runs.
    queueMicrotask(() => {
      if (created.consumers.size) void lookupSmall(created)
      else endSmall(created)
    })
  }
  const current = job
  if (priority === 'selected') current.priority = 'selected'
  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    const abort = (): void => {
      current.consumers.delete(consumer)
      if (!current.consumers.size) {
        const queued = smallQueue.indexOf(current)
        if (queued >= 0) {
          smallQueue.splice(queued, 1)
          endSmall(current)
        } else {
          // StrictMode/view handoffs can reacquire this fetch before the microtask.
          queueMicrotask(() => {
            if (current.consumers.size) return
            if (current.stage === 'lookup') {
              current.lookup.abort()
              return
            }
            if (current.stage !== 'running' || isEmbeddedPreview(current.url)) return
            if (smallJobs.get(current.key) === current) smallJobs.delete(current.key)
            cancelPreview(current.url, current)
          })
        }
      }
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const consumer: SmallConsumer = {
      signal,
      resolve: (canvas) => {
        signal.removeEventListener('abort', abort)
        resolve(canvas)
      },
      reject: (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    }
    current.consumers.add(consumer)
    signal.addEventListener('abort', abort, { once: true })
    if (current.stage === 'queued') {
      enqueueSmall(current)
      queueMicrotask(pumpSmall)
    }
  })
}

type FullEntry = { url: string; blob: Blob }
type FullConsumer = {
  ready: (entry: Held<FullEntry>) => void
  /** `retry` is true when newer work replaced this request; the source did not fail. */
  error: (retry?: boolean) => void
}
type FullJob = ImageRequest & {
  source: string
  consumers: Set<FullConsumer>
  priority: 'foreground' | 'background'
  stage: 'lookup' | 'queued' | 'running'
  epoch: number
  lookup: AbortController
}
const fullKey = (source: string): string => `full:${source}`
const fullJobs = new Map<string, FullJob>()
let running: FullJob | undefined
let pending: FullJob | undefined
let background: FullJob | undefined

export function cachedFullPreview(source: string): string | undefined {
  return getHeld<FullEntry>(fullKey(source))?.value.url
}

/** Drop an unused full JPEG, as after a background medium was made from it. */
export const forgetFullPreview = (source: string): void => forget(fullKey(source))

function endFull(job: FullJob): void {
  if (fullJobs.get(job.source) === job) fullJobs.delete(job.source)
}

function supersede(job: FullJob | undefined): void {
  if (!job) return
  endFull(job)
  for (const consumer of job.consumers) consumer.error(true)
}

function deliverFull(job: FullJob, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const entry = hold(
    fullKey(job.source),
    { url, blob },
    blob.size,
    () => URL.revokeObjectURL(url),
    job.epoch
  )
  for (const consumer of job.consumers) consumer.ready(entry)
}

async function lookupFull(job: FullJob): Promise<void> {
  let blob: Blob | undefined
  try {
    blob = await fetchCached(job.source, job.lookup.signal)
  } catch {
    // An abandoned lookup has no consumers; the check below ends it.
  }
  if (!job.consumers.size) return endFull(job)
  if (blob) {
    endFull(job)
    return deliverFull(job, blob)
  }
  job.stage = 'queued'
  if (job.priority === 'foreground') {
    if (pending !== job) supersede(pending)
    pending = job
    // Generation for the selection preempts background preparation.
    if (running?.priority === 'background') cancelPreview(running.source, running)
  } else {
    if (background !== job) supersede(background)
    background = job
  }
  pumpFull()
}

function pumpFull(): void {
  if (running) return
  const job = pending ?? background
  if (!pending) background = undefined
  pending = undefined
  if (!job) return
  const current = job
  current.stage = 'running'
  current.renderPriority = current.priority === 'foreground' ? 'high' : 'low'
  running = current
  void (async () => {
    try {
      const response = await fetchPreview(current.source, current)
      if (current.cancelled) throw new DOMException('Cancelled', 'AbortError')
      if (!response.ok) throw new Error(`preview ${response.status}`)
      const blob = await response.blob()
      if (current.cancelled) throw new DOMException('Cancelled', 'AbortError')
      deliverFull(current, blob)
    } catch {
      const retry = !!current.cancelled
      current.cancelled = true
      for (const consumer of current.consumers) consumer.error(retry)
    } finally {
      current.cancelled = true
      endFull(current)
      await current.end?.().catch(() => {})
      running = undefined
      pumpFull()
    }
  })()
}

function subscribeFull(
  source: string,
  ready: (entry: Held<FullEntry>) => void,
  error: (retry?: boolean) => void,
  priority: 'foreground' | 'background'
): () => void {
  let held: Held<FullEntry> | undefined
  let released = false
  const consumer: FullConsumer = {
    ready: (entry) => {
      if (released) return
      held = entry
      entry.users++
      ready(entry)
    },
    error
  }
  const cached = getHeld<FullEntry>(fullKey(source))
  let job: FullJob | undefined
  if (cached) consumer.ready(cached)
  else {
    job = fullJobs.get(source)
    if (job?.cancelled) job = undefined
    if (!job) {
      const created: FullJob = {
        source,
        consumers: new Set(),
        controller: new AbortController(),
        lookup: new AbortController(),
        priority,
        stage: 'lookup',
        epoch: memoryEpoch()
      }
      job = created
      fullJobs.set(source, created)
      // A synchronous handoff can release and reacquire the source first.
      queueMicrotask(() => {
        if (created.consumers.size) void lookupFull(created)
        else endFull(created)
      })
    } else if (priority === 'foreground' && job.priority === 'background') {
      job.priority = 'foreground'
      if (job === background) {
        background = undefined
        supersede(pending)
        pending = job
        if (running?.priority === 'background') cancelPreview(running.source, running)
      }
    }
    job.consumers.add(consumer)
    queueMicrotask(pumpFull)
  }
  return () => {
    if (released) return
    released = true
    job?.consumers.delete(consumer)
    if (job && !job.consumers.size) {
      const current = job
      if (pending === current) pending = undefined
      if (background === current) background = undefined
      if (current.stage === 'queued') endFull(current)
      else
        queueMicrotask(() => {
          if (current.consumers.size) return
          if (current.stage === 'lookup') current.lookup.abort()
          else if (current === running) cancelPreview(current.source, current)
        })
    }
    // Let a remounted viewer acquire the same URL before evicting an unpinned entry.
    if (held) unhold(held)
  }
}

/**
 * Stored full JPEGs load at once through the lookup lane. One extraction runs, with
 * one latest foreground and one background request waiting; no navigation backlog.
 */
export function subscribeFullPreview(
  source: string,
  ready: (url: string) => void,
  error: (retry?: boolean) => void,
  priority: 'foreground' | 'background' = 'foreground'
): () => void {
  return subscribeFull(source, (entry) => ready(entry.value.url), error, priority)
}

/** Share the transport's original bytes with the fit-image worker, without another fetch. */
export function subscribeFullPreviewBlob(
  source: string,
  ready: (blob: Blob) => void,
  error: (retry?: boolean) => void,
  priority: 'foreground' | 'background' = 'foreground'
): () => void {
  return subscribeFull(source, (entry) => ready(entry.value.blob), error, priority)
}
