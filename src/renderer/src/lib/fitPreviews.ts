import {
  forgetFullPreview,
  subscribeFullPreviewBlob,
  thumbnailsIdle,
  whenThumbnailsIdle
} from './previewImages'
import { cachedFrame, isEditedFrame, loadFrame, type Frame } from './frames'
import {
  getHeld,
  hold,
  keepWarm,
  memoryEpoch,
  onMemoryClear,
  unhold,
  type Held
} from './memoryCache'

export type FitPreview = {
  image: ImageBitmap | HTMLCanvasElement
  /** Original, oriented JPEG dimensions, independent of the smaller display image. */
  width: number
  height: number
}
type Encoded = { blob: Blob; width: number; height: number }
type Decoded = FitPreview & { release: () => void }
type Result = FitPreview & { blob: Blob }
type Consumer = { ready: (preview: Held<Decoded>) => void; error: () => void }
type Job = {
  source: string
  consumers: Set<Consumer>
  priority: 'foreground' | 'background'
  cancelled: boolean
  /** The Clear count when the job started. */
  epoch: number
  cancelWaiting?: () => void
  promote?: () => void
}
const decodedKey = (source: string): string => `fit:${source}`
const encodedKey = (source: string): string => `medium:${source}`
/** Jobs by source: the foreground jobs and at most one background job. */
const jobs = new Map<string, Job>()
const prepared = new Set<string>()
let background: Job | undefined
let targets: string[] = []
let prefetchSources = new Set<string>()
let warm = new Set<string>()
let waitForThumbnails: (() => void) | undefined
let worker: Worker | undefined
let workerDisabled = false
let workerId = 0
let waiting: { id: number; resolve: (result: Result) => void; reject: () => void } | undefined

// Prepare again what the Clear removed.
onMemoryClear(() => prepared.clear())

/** A few slots; foreground waiters go before background waiters. */
function slots(limit: number): (foreground: boolean) => Promise<() => void> {
  let busy = 0
  const queue: Array<{ foreground: boolean; start: () => void }> = []
  const next = (): void => {
    if (busy < limit) queue.shift()?.start()
  }
  return (foreground) =>
    new Promise((resolve) => {
      const start = (): void => {
        busy++
        let done = false
        resolve(() => {
          if (done) return
          done = true
          busy--
          next()
        })
      }
      const index = foreground ? queue.findIndex((other) => !other.foreground) : -1
      queue.splice(index < 0 ? queue.length : index, 0, { foreground, start })
      next()
    })
}
/** The worker decodes one image at a time. */
const decodeSlot = slots(1)
/** Native renders are serialized; one waits here so that the selection can go first. */
const renderSlot = slots(1)

function releaseImage(image: FitPreview['image']): void {
  if ('close' in image) image.close()
  else image.width = image.height = 0
}

export function cachedFitPreview(source: string): FitPreview | undefined {
  return getHeld<Decoded>(decodedKey(source))?.value
}

function disableWorker(): void {
  worker?.terminate()
  worker = undefined
  workerDisabled = true
  waiting?.reject()
  waiting = undefined
}

function renderWorker(blob: Blob, original?: Encoded): Promise<Result> {
  return new Promise((resolve, reject) => {
    try {
      if (!worker) {
        worker = new Worker(new URL('./fitPreview.worker.ts', import.meta.url), { type: 'module' })
        const current = worker
        worker.onmessage = (
          event: MessageEvent<
            Omit<Result, 'image'> & { image: ImageBitmap; id: number; failed?: boolean }
          >
        ) => {
          const result = event.data
          if (worker !== current || waiting?.id !== result.id) {
            result.image?.close()
            return
          }
          if (result.failed) disableWorker()
          else {
            const complete = waiting.resolve
            waiting = undefined
            complete(result)
          }
        }
        worker.onerror = (event) => {
          event.preventDefault()
          if (worker === current) disableWorker()
        }
      }
      const id = ++workerId
      waiting = { id, resolve, reject: () => reject(new Error('Fit preview worker unavailable')) }
      worker.postMessage({
        id,
        blob,
        original: original && { width: original.width, height: original.height }
      })
    } catch {
      disableWorker()
      reject(new Error('Fit preview worker unavailable'))
    }
  })
}

async function renderFallback(
  blob: Blob,
  original: Encoded | undefined,
  job: Job
): Promise<Result> {
  let image: ImageBitmap | HTMLImageElement
  let url: string | undefined
  if (typeof createImageBitmap === 'function') {
    image = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } else {
    image = new Image()
    image.decoding = 'async'
    url = URL.createObjectURL(blob)
    image.src = url
    try {
      await image.decode()
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
  }
  try {
    if (job.cancelled) throw new Error('Cancelled')
    const width = original?.width ?? ('naturalWidth' in image ? image.naturalWidth : image.width)
    const height =
      original?.height ?? ('naturalHeight' in image ? image.naturalHeight : image.height)
    const scale = Math.min(1, 2048 / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No fit preview canvas')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const medium =
      original?.blob ??
      (await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) =>
            result ? resolve(result) : reject(new Error('Could not encode fit preview')),
          'image/jpeg',
          0.9
        )
      }))
    return { image: canvas, blob: medium, width, height }
  } finally {
    if ('close' in image) image.close()
    if (url) URL.revokeObjectURL(url)
  }
}

function cancel(job: Job): void {
  job.cancelled = true
  job.cancelWaiting?.()
}

/** Selection work that needs generation stops background preparation, which comes back later. */
function yieldBackground(job: Job): void {
  if (job.priority === 'foreground' && background && !background.consumers.size) cancel(background)
}

/** Native editor frames are already sized and color-managed; draw their pixels as they are. */
async function renderedFrame(job: Job): Promise<Frame> {
  const controller = new AbortController()
  job.cancelWaiting = () => controller.abort()
  try {
    const stored = await cachedFrame(job.source, controller.signal)
    if (stored) return stored
    if (job.cancelled) throw new Error('Cancelled')
    yieldBackground(job)
    const done = await renderSlot(job.priority === 'foreground')
    try {
      if (job.cancelled) throw new Error('Cancelled')
      return await loadFrame(
        job.source,
        controller.signal,
        job.priority === 'foreground' ? 'high' : 'low'
      )
    } finally {
      done()
    }
  } finally {
    job.cancelWaiting = undefined
  }
}

async function decodeSource(job: Job): Promise<Decoded> {
  const saved = getHeld<Encoded>(encodedKey(job.source))
  // The decode reads the saved medium; keep it while the job uses it.
  if (saved) saved.users++
  try {
    const blob = saved?.value.blob ?? (await sourceBlob(job))
    if (!blob || job.cancelled) throw new Error('Cancelled or unavailable')
    const done = await decodeSlot(job.priority === 'foreground')
    let result: Result
    try {
      if (job.cancelled) throw new Error('Cancelled')
      if (!workerDisabled && typeof Worker !== 'undefined') {
        try {
          result = await renderWorker(blob, saved?.value)
        } catch {
          if (job.cancelled) throw new Error('Cancelled')
          result = await renderFallback(blob, saved?.value, job)
        }
      } else result = await renderFallback(blob, saved?.value, job)
    } finally {
      done()
    }
    if (!saved && !job.cancelled) {
      const { blob: medium, width, height } = result
      hold(
        encodedKey(job.source),
        { blob: medium, width, height },
        medium.size,
        undefined,
        job.epoch
      )
      // The medium replaces the full JPEG that background work fetched.
      if (job.priority === 'background') forgetFullPreview(job.source)
    }
    const { image, width, height } = result
    return { image, width, height, release: () => releaseImage(image) }
  } finally {
    if (saved) unhold(saved)
  }
}

async function sourceBlob(job: Job): Promise<Blob | undefined> {
  let release = (): void => {}
  let settled = false
  try {
    return await new Promise<Blob | undefined>((resolve) => {
      const subscribe = (): void => {
        release()
        release = subscribeFullPreviewBlob(
          job.source,
          (blob) => {
            settled = true
            resolve(blob)
          },
          (retry) => {
            settled = true
            // Background work that the selection replaced comes back later.
            if (retry && job.priority === 'background' && !job.consumers.size) cancel(job)
            resolve(undefined)
          },
          job.priority
        )
      }
      job.cancelWaiting = () => {
        release()
        resolve(undefined)
      }
      job.promote = () => {
        if (!settled) subscribe()
      }
      subscribe()
    })
  } finally {
    release()
    job.cancelWaiting = job.promote = undefined
  }
}

function run(job: Job): void {
  void (async () => {
    try {
      let entry: Decoded
      if (isEditedFrame(job.source)) entry = { ...(await renderedFrame(job)) }
      else entry = await decodeSource(job)
      if (job.cancelled) {
        entry.release()
        return
      }
      if (job.epoch === memoryEpoch()) prepared.add(job.source)
      // Beyond the nearest photos, background preparation keeps only the compact medium.
      if (!job.consumers.size && !warm.has(job.source) && !isEditedFrame(job.source)) {
        entry.release()
        return
      }
      const { width, height } = entry.image
      const held = hold(decodedKey(job.source), entry, width * height * 4, entry.release, job.epoch)
      // The compact medium goes after its decoded image in the LRU, so that it stays longer.
      getHeld(encodedKey(job.source))
      for (const consumer of job.consumers) consumer.ready(held)
    } catch {
      if (!job.cancelled) for (const consumer of job.consumers) consumer.error()
    } finally {
      if (jobs.get(job.source) === job) jobs.delete(job.source)
      if (background === job) background = undefined
      if (job.cancelled && prefetchSources.has(job.source) && !targets.includes(job.source))
        targets.unshift(job.source)
      pump()
    }
  })()
}

const needed = (source: string): boolean =>
  !jobs.has(source) &&
  !getHeld(decodedKey(source)) &&
  (warm.has(source) || (!prepared.has(source) && !getHeld(encodedKey(source))))

/**
 * One background job at a time, after the selection and the visible thumbnails.
 * Foreground jobs start at once and do not wait here.
 */
function pump(): void {
  if (background || [...jobs.values()].some((job) => job.priority === 'foreground')) return
  if (!thumbnailsIdle()) {
    waitForThumbnails ??= whenThumbnailsIdle(() => {
      waitForThumbnails = undefined
      pump()
    })
    return
  }
  while (targets.length) {
    const source = targets.shift()!
    if (!needed(source)) continue
    const job: Job = {
      source,
      consumers: new Set(),
      priority: 'background',
      cancelled: false,
      epoch: memoryEpoch()
    }
    background = job
    jobs.set(source, job)
    return run(job)
  }
}

/**
 * Stored mediums and frames load at once; generation for the selection preempts
 * background preparation. Active consumers pin their decoded image and encoded
 * medium across viewer handoffs.
 */
export function subscribeFitPreview(
  source: string,
  ready: (preview: FitPreview) => void,
  error: () => void
): () => void {
  let held: Held<Decoded> | undefined
  let compressed: Held<Encoded> | undefined
  let released = false
  const consumer: Consumer = {
    ready(entry) {
      held = entry
      entry.users++
      compressed = getHeld<Encoded>(encodedKey(source))
      if (compressed) compressed.users++
      ready(entry.value)
    },
    error
  }
  let job: Job | undefined
  const cached = getHeld<Decoded>(decodedKey(source))
  if (cached) consumer.ready(cached)
  else {
    job = jobs.get(source)
    if (job?.cancelled) job = undefined
    if (!job) {
      const created: Job = {
        source,
        consumers: new Set(),
        priority: 'foreground',
        cancelled: false,
        epoch: memoryEpoch()
      }
      job = created
      jobs.set(source, created)
      // A synchronous handoff or rapid selection can release the job first.
      queueMicrotask(() => {
        if (created.cancelled) {
          if (jobs.get(source) === created) jobs.delete(source)
          pump()
        } else run(created)
      })
    } else if (job.priority === 'background') {
      job.priority = 'foreground'
      if (background === job) background = undefined
      job.promote?.()
    }
    job.consumers.add(consumer)
  }
  return () => {
    if (released) return
    released = true
    job?.consumers.delete(consumer)
    if (job && !job.consumers.size) cancel(job)
    if (held) unhold(held)
    if (compressed) unhold(compressed)
  }
}

/** Prepare each revision once in the background; an eviction never restarts a whole queue scan. */
export function prefetchFitPreviews(sources: string[]): () => void {
  const candidates = [...new Set(sources)]
  const current = new Set(candidates)
  prefetchSources = current
  warm = new Set(candidates.slice(0, 4))
  keepWarm([...warm].flatMap((source) => [decodedKey(source), encodedKey(source)]))
  for (const source of prepared) if (!current.has(source)) prepared.delete(source)
  // Rendered frames keep no compact copy; beyond the warm set the decoded cache would drop them.
  const queue = candidates.filter((source) => warm.has(source) || !isEditedFrame(source))
  targets = queue
  if (background && !background.consumers.size && !current.has(background.source))
    cancel(background)
  queueMicrotask(pump)
  return () => {
    if (targets !== queue) return
    targets = []
    prefetchSources = new Set()
    warm = new Set()
    keepWarm([])
    waitForThumbnails?.()
    waitForThumbnails = undefined
    if (background && !background.consumers.size) cancel(background)
  }
}
