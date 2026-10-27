import { displayPreviewUrl, isRenderedPreview } from '@shared/preview'
import type { X3FFileDTO } from '@shared/types'
import { useNavStore } from '../stores/navStore'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { subscribeFitPreview } from './fitPreviews'
import { ipc } from './ipc'
import { painted } from './nativeSmoke'
import { loadSmallPreview } from './previewImages'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function summary(samples: number[]): Record<string, number> {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    count: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    maxMs: sorted.at(-1) ?? 0
  }
}

function largePreview(file: X3FFileDTO): Promise<void> {
  return new Promise((resolve, reject) => {
    let release = (): void => {}
    const timer = setTimeout(() => {
      release()
      reject(new Error(`Large preview timed out: ${file.fileName}`))
    }, 180000)
    release = subscribeFitPreview(
      displayPreviewUrl(file, 'full'),
      () => {
        clearTimeout(timer)
        queueMicrotask(() => release())
        resolve()
      },
      () => {
        clearTimeout(timer)
        queueMicrotask(() => release())
        reject(new Error(`Large preview failed: ${file.fileName}`))
      }
    )
  })
}

/** The launcher supplies temporary photo copies and isolated application storage. */
export async function runPreviewCacheSmoke(
  paths: string[],
  warmup: boolean
): Promise<Record<string, unknown>> {
  await useSettingsStore.getState().load()
  await useSettingsStore.getState().update({
    queueViewMode: 'grid',
    inspectorOpen: false,
    sortField: 'File Name',
    sortAscending: true,
    debugLoggingEnabled: true
  })
  await painted()
  useNavStore.getState().goToQueue()
  useQueueStore.getState().clearQueue()
  const names = new Set(paths.map((path) => path.split(/[\\/]/).at(-1)!))
  const started = performance.now()
  let firstThumbnailMs: number | undefined
  let firstGridMs: number | undefined
  let frame = 0
  let observedFrames = 0
  let visibleCells = 0
  let paintedCells = 0
  const observe = (): void => {
    observedFrames++
    const cells = [...document.querySelectorAll<HTMLElement>('div[title]')].filter((cell) => {
      if (!names.has(cell.title)) return false
      const box = cell.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && box.top < innerHeight && box.bottom > 0
    })
    const ready = cells.filter((cell) =>
      [...cell.querySelectorAll('canvas[role="img"]')].some(
        (canvas) => getComputedStyle(canvas).opacity === '1'
      )
    )
    visibleCells = cells.length
    paintedCells = ready.length
    if (ready.length) firstThumbnailMs ??= performance.now() - started
    if (cells.length && ready.length === cells.length) firstGridMs ??= performance.now() - started
    frame = requestAnimationFrame(observe)
  }
  frame = requestAnimationFrame(observe)
  try {
    window.__x3fSmokeProgress = `Importing ${paths.length} cache benchmark photos`
    await useQueueStore.getState().addFiles(paths)
    const importMs = performance.now() - started
    const files = useQueueStore.getState().files
    if (files.length !== paths.length || files.some((file) => file.pending || file.editError)) {
      throw new Error('Cache benchmark import failed or found invalid saved edits')
    }
    const thumbnailSamples: number[] = []
    const largeSamples: number[] = []
    for (const [index, file] of files.entries()) {
      window.__x3fSmokeProgress = `Preview cache ${warmup ? 'warmup' : 'restart'} ${index + 1}/${files.length}: ${file.fileName}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 180000)
      const smallStarted = performance.now()
      try {
        await loadSmallPreview(
          displayPreviewUrl(file),
          isRenderedPreview(file) ? 1 : (file.orientation ?? 1),
          isRenderedPreview(file) ? undefined : file.aspectRatio,
          controller.signal
        )
      } finally {
        clearTimeout(timer)
      }
      thumbnailSamples.push(performance.now() - smallStarted)
      const largeStarted = performance.now()
      await largePreview(file)
      largeSamples.push(performance.now() - largeStarted)
    }
    // Native persistence follows the response. Wait for disk usage to stop changing.
    window.__x3fSmokeProgress = 'Waiting for preview cache writes'
    let cacheBytes = await ipc.invoke('cache:size')
    let stableSince = performance.now()
    const deadline = stableSince + 60000
    while (performance.now() - stableSince < 2000) {
      if (performance.now() >= deadline) throw new Error('Preview cache writes did not settle')
      await wait(200)
      const bytes = await ipc.invoke('cache:size')
      if (bytes !== cacheBytes) stableSince = performance.now()
      cacheBytes = bytes
    }
    const thumbnails = summary(thumbnailSamples)
    const largePreviews = summary(largeSamples)
    return {
      ok: firstGridMs !== undefined,
      paintVerified: firstGridMs !== undefined,
      measurement: 'visible-native',
      phase: warmup ? 'cold-warmup' : 'application-restart',
      files: files.length,
      editedFiles: files.filter((file) => file.edit).length,
      importMs,
      firstThumbnailMs,
      firstGridMs,
      ...(firstGridMs === undefined
        ? {
            paintFailure: {
              observedFrames,
              visibleCells,
              paintedCells,
              visibility: document.visibilityState,
              focused: document.hasFocus(),
              viewport: [innerWidth, innerHeight],
              titles: [...document.querySelectorAll('[title]')].map((cell) =>
                cell.getAttribute('title')
              ),
              canvases: document.querySelectorAll('canvas').length,
              screen: document.body.innerText.slice(0, 1000)
            }
          }
        : {}),
      thumbnails,
      largePreviews,
      cacheBytes,
      cacheLimit: useSettingsStore.getState().settings.previewCacheLimit,
      targets: {
        firstGridUnder1000Ms: firstGridMs !== undefined && firstGridMs < 1000,
        thumbnailP95Under100Ms: thumbnails.p95Ms < 100,
        largePreviewP95Under250Ms: largePreviews.p95Ms < 250
      },
      method:
        'Real files in a native webview. Import and first grid paint include source validation. Per-image timings use the application loaders after import; visible images and background work can warm memory. The second process retains disk cache but starts with empty application memory. Application storage is isolated; the WebKit data directory is shared. OS disk caches are not flushed.'
    }
  } finally {
    cancelAnimationFrame(frame)
  }
}
