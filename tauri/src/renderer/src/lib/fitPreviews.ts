import { subscribeFullPreviewBlob } from './previewImages'

export type FitPreview = {
  image: ImageBitmap | HTMLCanvasElement
  /** Original, oriented JPEG dimensions, independent of the smaller display image. */
  width: number
  height: number
}
type Encoded = { blob: Blob; width: number; height: number; users: number }
type Decoded = FitPreview & { users: number }
type Result = FitPreview & { blob: Blob }
type Consumer = { ready: (preview: Decoded) => void; error: () => void }
type Job = {
  source: string
  consumers: Set<Consumer>
  priority: 'foreground' | 'background'
  cancelled: boolean
  cancelWaiting?: () => void
  promote?: () => void
}
const decoded = new Map<string, Decoded>()
const encoded = new Map<string, Encoded>()
const prepared = new Set<string>()
let decodedBytes = 0
let encodedBytes = 0
let running: Job | undefined
let pending: Job | undefined
let targets: string[] = []
let prefetchSources = new Set<string>()
let warm = new Set<string>()
let worker: Worker | undefined
let workerDisabled = false
let workerId = 0
let waiting: { id: number; resolve: (result: Result) => void; reject: () => void } | undefined

function releaseImage(image: FitPreview['image']): void {
  if ('close' in image) image.close()
  else image.width = image.height = 0
}

function trim(): void {
  for (const [source, entry] of decoded) {
    if (decodedBytes <= 64 * 1024 * 1024) break
    if (entry.users || warm.has(source)) continue
    decoded.delete(source)
    decodedBytes -= entry.image.width * entry.image.height * 4
    releaseImage(entry.image)
  }
  for (const [source, entry] of encoded) {
    if (encodedBytes <= 128 * 1024 * 1024) break
    if (entry.users || warm.has(source)) continue
    encoded.delete(source)
    encodedBytes -= entry.blob.size
  }
}

export function cachedFitPreview(source: string): FitPreview | undefined {
  const entry = decoded.get(source)
  if (entry) {
    decoded.delete(source)
    decoded.set(source, entry)
  }
  return entry
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
          () => {
            settled = true
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

function pump(): void {
  if (running) return
  let job = pending
  pending = undefined
  while (!job && targets.length) {
    const source = targets.shift()!
    if (
      !decoded.has(source) &&
      (warm.has(source) || (!prepared.has(source) && !encoded.has(source)))
    ) {
      job = { source, consumers: new Set(), priority: 'background', cancelled: false }
    }
  }
  if (!job) return
  const current = job
  running = current
  void (async () => {
    try {
      const saved = encoded.get(current.source)
      if (saved) {
        encoded.delete(current.source)
        encoded.set(current.source, saved)
      }
      const blob = saved?.blob ?? (await sourceBlob(current))
      if (!blob || current.cancelled) throw new Error('Cancelled or unavailable')
      let result: Result
      if (!workerDisabled && typeof Worker !== 'undefined') {
        try {
          result = await renderWorker(blob, saved)
        } catch {
          if (current.cancelled) throw new Error('Cancelled')
          result = await renderFallback(blob, saved, current)
        }
      } else result = await renderFallback(blob, saved, current)
      if (current.cancelled) {
        releaseImage(result.image)
        return
      }
      if (!saved) {
        encoded.set(current.source, {
          blob: result.blob,
          width: result.width,
          height: result.height,
          users: 0
        })
        encodedBytes += result.blob.size
      }
      const entry = { image: result.image, width: result.width, height: result.height, users: 0 }
      decoded.set(current.source, entry)
      decodedBytes += entry.image.width * entry.image.height * 4
      prepared.add(current.source)
      for (const consumer of current.consumers) consumer.ready(entry)
      trim()
    } catch {
      if (!current.cancelled) for (const consumer of current.consumers) consumer.error()
    } finally {
      running = undefined
      if (
        current.cancelled &&
        prefetchSources.has(current.source) &&
        !targets.includes(current.source)
      )
        targets.push(current.source)
      pump()
    }
  })()
}

/** Active consumers pin their decoded image and encoded medium across viewer handoffs. */
export function subscribeFitPreview(
  source: string,
  ready: (preview: FitPreview) => void,
  error: () => void
): () => void {
  let held: Decoded | undefined
  let compressed: Encoded | undefined
  let released = false
  const consumer: Consumer = {
    ready(entry) {
      held = entry
      entry.users++
      compressed = encoded.get(source)
      if (compressed) compressed.users++
      ready(entry)
    },
    error
  }
  let job: Job | undefined
  const cached = cachedFitPreview(source) as Decoded | undefined
  if (cached) consumer.ready(cached)
  else {
    job =
      running?.source === source && !running.cancelled
        ? running
        : pending?.source === source
          ? pending
          : undefined
    if (!job) {
      if (pending) {
        cancel(pending)
        for (const previous of pending.consumers) previous.error()
      }
      job = { source, consumers: new Set(), priority: 'foreground', cancelled: false }
      pending = job
      if (running && !running.consumers.size) cancel(running)
    }
    job.consumers.add(consumer)
    if (job.priority === 'background') {
      job.priority = 'foreground'
      job.promote?.()
    }
    queueMicrotask(pump)
  }
  return () => {
    if (released) return
    released = true
    job?.consumers.delete(consumer)
    if (job && !job.consumers.size) {
      if (pending === job) pending = undefined
      cancel(job)
    }
    if (held) held.users--
    if (compressed) compressed.users--
    queueMicrotask(trim)
  }
}

/** Prepare each revision once in the background; an eviction never restarts a whole queue scan. */
export function prefetchFitPreviews(sources: string[]): () => void {
  const candidates = [...new Set(sources)]
  const current = new Set(candidates)
  prefetchSources = current
  warm = new Set(candidates.slice(0, 4))
  trim()
  for (const source of prepared) if (!current.has(source)) prepared.delete(source)
  targets = candidates
  if (running?.priority === 'background' && !running.consumers.size && !current.has(running.source))
    cancel(running)
  queueMicrotask(pump)
  return () => {
    if (targets !== candidates) return
    targets = []
    prefetchSources = new Set()
    warm = new Set()
    trim()
    if (running?.priority === 'background' && !running.consumers.size) cancel(running)
  }
}
