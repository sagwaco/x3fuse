import { drawScope, type ScopeRenderRequest } from './scopeRenderer'

export type RenderedScope = ImageBitmap | HTMLCanvasElement
const cache = new Map<string, RenderedScope>()
const imageIds = new WeakMap<ImageData, number>()
let nextImageId = 0
let cachedBytes = 0
const CACHE_BUDGET = 16 * 1024 * 1024

export function scopeRenderKey({ image, mode, width, pixelRatio }: ScopeRenderRequest): string {
  let id = imageIds.get(image)
  if (id === undefined) imageIds.set(image, (id = ++nextImageId))
  return `${id}:${mode}:${width}:${pixelRatio}`
}

export function cachedScope(key: string): RenderedScope | undefined {
  const result = cache.get(key)
  if (result) {
    cache.delete(key)
    cache.set(key, result)
  }
  return result
}

function release(result: RenderedScope): void {
  if ('close' in result) result.close()
  else result.width = result.height = 0
}

function retain(key: string, result: RenderedScope): boolean {
  const bytes = result.width * result.height * 4
  if (bytes > CACHE_BUDGET) return false
  const previous = cache.get(key)
  if (previous) {
    cachedBytes -= previous.width * previous.height * 4
    cache.delete(key)
    release(previous)
  }
  cache.set(key, result)
  cachedBytes += bytes
  while (cachedBytes > CACHE_BUDGET) {
    const oldest = cache.keys().next().value!
    const evicted = cache.get(oldest)!
    cachedBytes -= evicted.width * evicted.height * 4
    cache.delete(oldest)
    release(evicted)
  }
  return true
}

interface Task {
  id: number
  key: string
  request: ScopeRenderRequest
  cancelled: boolean
  complete: (result: RenderedScope) => void
  failed: () => void
}

/** One inspector, one running job and one replaceable next job; never queue old selections. */
export function createScopeRenderer(): {
  render: (
    request: ScopeRenderRequest,
    complete: Task['complete'],
    failed: Task['failed']
  ) => () => void
  dispose: () => void
} {
  let worker: Worker | undefined
  let fallback = typeof Worker === 'undefined'
  let disposed = false
  let nextId = 0
  let running: Task | undefined
  let pending: Task | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let fallbackCanvas: HTMLCanvasElement | undefined

  const finish = (result?: RenderedScope): void => {
    const task = running
    running = undefined
    fallbackCanvas = undefined
    if (!disposed && task && !task.cancelled) {
      if (result) {
        const retained = retain(task.key, result)
        task.complete(result)
        if (!retained) release(result)
      } else task.failed()
    } else if (result) release(result)
    start()
  }

  const drawFallback = (): void => {
    const task = running!
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(task.request.width * task.request.pixelRatio)
    canvas.height = Math.round(200 * task.request.pixelRatio)
    fallbackCanvas = canvas
    const context = canvas.getContext('2d')
    if (!context) {
      finish()
      return
    }
    const steps = drawScope(context, task.request)
    const draw = (): void => {
      timer = undefined
      if (disposed || task.cancelled) {
        release(canvas)
        finish()
        return
      }
      try {
        const deadline = performance.now() + 4
        do {
          if (steps.next().done) {
            finish(canvas)
            return
          }
        } while (performance.now() < deadline)
        timer = setTimeout(draw, 0)
      } catch {
        release(canvas)
        finish()
      }
    }
    // Cold work starts after the selection/menu update can commit.
    timer = setTimeout(draw, 0)
  }

  const activateFallback = (): void => {
    worker?.terminate()
    worker = undefined
    fallback = true
    if (running) {
      if (running.cancelled) finish()
      else drawFallback()
    }
  }

  const start = (): void => {
    if (disposed || running || !pending) return
    running = pending
    pending = undefined
    const cached = cachedScope(running.key)
    if (cached) {
      const task = running
      running = undefined
      task.complete(cached)
      return
    }
    if (fallback) {
      drawFallback()
      return
    }
    try {
      if (!worker) {
        worker = new Worker(new URL('./scope.worker.ts', import.meta.url), { type: 'module' })
        const activeWorker = worker
        worker.onmessage = (
          event: MessageEvent<{ id: number; bitmap?: ImageBitmap; failed?: boolean }>
        ): void => {
          const { id, bitmap, failed } = event.data
          if (disposed || worker !== activeWorker || running?.id !== id) {
            bitmap?.close()
            return
          }
          if (failed) activateFallback()
          else finish(bitmap)
        }
        worker.onerror = (event): void => {
          event.preventDefault()
          if (!disposed && worker === activeWorker) activateFallback()
        }
      }
      // Clone the small sampled pixels; their cached buffer must stay usable on revisit.
      worker.postMessage({ ...running.request, id: running.id })
    } catch {
      activateFallback()
    }
  }

  return {
    render(request, complete, failed) {
      if (disposed) return () => {}
      const task: Task = {
        id: ++nextId,
        key: scopeRenderKey(request),
        request,
        cancelled: false,
        complete,
        failed
      }
      if (running) running.cancelled = true
      if (pending) pending.cancelled = true
      pending = task
      start()
      return () => {
        task.cancelled = true
        if (pending === task) pending = undefined
      }
    },
    dispose() {
      disposed = true
      worker?.terminate()
      clearTimeout(timer)
      if (fallbackCanvas) release(fallbackCanvas)
      running = pending = undefined
    }
  }
}
