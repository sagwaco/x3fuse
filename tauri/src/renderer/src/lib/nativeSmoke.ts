import { previewUrl } from '@shared/preview'
import { SCOPE_MODES, type X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { usePreviewStore } from '../stores/previewStore'
import { ipc } from './ipc'
import { t } from './strings'

declare global {
  interface Window {
    __x3fRunNativeSmoke?: (input: string) => Promise<Record<string, unknown>>
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const painted = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 15000
  while (!predicate()) {
    check(performance.now() < deadline, message)
    await wait(20)
  }
}
function timings(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    maxMs: sorted.at(-1) ?? 0
  }
}

async function checkPreview(file: X3FFileDTO, variant: 'preview' | 'full') {
  const started = performance.now()
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = previewUrl(file.path, variant, file.id)
  await until(() => image.complete, `${variant} preview timed out`)
  check(image.naturalWidth > 0, `${variant} preview could not decode`)
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 16
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0, 16, 16)
  const pixels = context.getImageData(0, 0, 16, 16).data
  check(
    pixels.some((value, index) => index % 4 === 3 && value > 0),
    'Preview has no visible pixels'
  )
  return {
    variant,
    width: image.naturalWidth,
    height: image.naturalHeight,
    milliseconds: performance.now() - started
  }
}

async function checkScopeWorker() {
  const started = performance.now()
  const worker = new Worker(new URL('./scope.worker.ts', import.meta.url), { type: 'module' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const image = new ImageData(320, 180)
    for (let index = 0; index < image.data.length; index += 4) {
      image.data[index] = index % 256
      image.data[index + 1] = Math.floor(index / 320) % 256
      image.data[index + 2] = 255 - image.data[index]
      image.data[index + 3] = 255
    }
    const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ bitmap?: ImageBitmap }>) =>
        event.data.bitmap ? resolve(event.data.bitmap) : reject(new Error('Scope worker failed'))
      worker.onerror = (event) => reject(new Error(`Scope worker/CSP error: ${event.message}`))
      timer = setTimeout(() => reject(new Error('Scope worker timed out')), 15000)
      worker.postMessage({ id: 1, image, mode: 'rgbParade', width: 280, pixelRatio: 1 })
    })
    const result = {
      executed: true,
      syntheticInput: '320×180 generated pixels',
      width: bitmap.width,
      height: bitmap.height,
      milliseconds: performance.now() - started
    }
    bitmap.close()
    check(
      result.width === 280 && result.height === 200,
      'Scope worker returned incorrect dimensions'
    )
    return result
  } finally {
    clearTimeout(timer)
    worker.terminate()
  }
}

async function checkFitWorker() {
  const source = document.createElement('canvas')
  source.width = 4096
  source.height = 2730
  const context = source.getContext('2d')!
  context.fillStyle = 'rgb(32, 128, 224)'
  context.fillRect(0, 0, source.width, source.height)
  const blob = await new Promise<Blob>((resolve, reject) =>
    source.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('Synthetic JPEG encoding failed'))),
      'image/jpeg',
      0.95
    )
  )
  source.width = source.height = 0
  const started = performance.now()
  const worker = new Worker(new URL('./fitPreview.worker.ts', import.meta.url), { type: 'module' })
  type Reply = { id: number; image?: ImageBitmap; blob?: Blob; width: number; height: number }
  const decode = (input: Blob, original?: { width: number; height: number }): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fit preview worker timed out')), 15000)
      worker.onmessage = (event: MessageEvent<Reply>) => {
        clearTimeout(timer)
        if (event.data.image) resolve(event.data)
        else reject(new Error('Fit preview worker failed'))
      }
      worker.onerror = (event) => {
        clearTimeout(timer)
        reject(new Error(`Fit preview worker/CSP error: ${event.message}`))
      }
      worker.postMessage({ id: 1, blob: input, original })
    })
  try {
    const medium = await decode(blob)
    check(medium.image && medium.blob, 'Worker did not return a reusable medium preview')
    check(
      medium.width === 4096 && medium.height === 2730,
      'Medium preview lost original dimensions'
    )
    check(
      medium.image.width === 2048 && medium.image.height === 1365,
      'Medium preview did not preserve aspect at 2048px'
    )
    const checkPixels = (image: ImageBitmap): void => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      canvas.getContext('2d')!.drawImage(image, 0, 0, 1, 1)
      const pixel = canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data
      check(
        [32, 128, 224, 255].every((value, index) => Math.abs(pixel[index] - value) < 10),
        'Medium preview is blank or changed the known synthetic color'
      )
      image.close()
    }
    checkPixels(medium.image)
    const revisited = await decode(medium.blob, { width: medium.width, height: medium.height })
    check(
      revisited.image && revisited.width === 4096 && revisited.height === 2730,
      'Medium cache revisit changed original dimensions'
    )
    checkPixels(revisited.image)
    return {
      synthetic: true,
      sourceWidth: 4096,
      sourceHeight: 2730,
      mediumWidth: 2048,
      mediumHeight: 1365,
      knownColorPreserved: true,
      originalDimensionsPreserved: true,
      cachedMediumDecoded: true,
      milliseconds: performance.now() - started
    }
  } finally {
    worker.terminate()
  }
}

async function checkFitHandoff() {
  const region = (): HTMLElement | null =>
    document.querySelector(`[role="region"][aria-label="${CSS.escape(t('preview.image'))}"]`)
  const medium = (): HTMLCanvasElement | null =>
    region()?.querySelector('[data-fit-preview]') ?? null
  const full = (): HTMLImageElement | null => region()?.querySelector('[data-full-preview]') ?? null
  const hasPixels = (): boolean => {
    const canvas = medium()
    return (
      !!canvas &&
      canvas.width > 0 &&
      canvas.height > 0 &&
      canvas
        .getContext('2d')!
        .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[3] > 0
    )
  }
  await until(
    () => hasPixels() && !!usePreviewStore.getState().controls,
    'Medium Fit preview did not paint'
  )
  check(!full(), 'Fit view created a full-resolution DOM image before zoom')
  const dimensions = (): string => {
    const element = region()?.querySelector<HTMLElement>('.preview-image')
    check(element, 'Zoom geometry is missing')
    return `${element.style.width}×${element.style.height}`
  }
  const originalDimensions = dimensions()
  for (let frame = 0; frame < 3; frame++) {
    await painted()
    check(hasPixels(), 'Medium Fit canvas became blank after rendering')
  }
  const originalDecode = HTMLImageElement.prototype.decode
  let releaseDecode!: () => void
  const decodeGate = new Promise<void>((resolve) => {
    releaseDecode = resolve
  })
  let pendingDecodeObserved = false
  // The bundled RAW fixture has an 8×8 JPEG: hold only the full overlay's
  // real decode completion to exercise the asynchronous handoff deterministically.
  HTMLImageElement.prototype.decode = function () {
    const decoded = originalDecode.call(this)
    if (!this.hasAttribute('data-full-preview')) return decoded
    pendingDecodeObserved = true
    return decoded.then(() => decodeGate)
  }
  try {
    const controls = usePreviewStore.getState().controls!
    controls.zoomTo(Math.min(controls.maxZoom, controls.scale * 2))
    await until(() => pendingDecodeObserved && !!full(), 'Zoom did not decode the original JPEG')
    for (let frame = 0; frame < 3; frame++) {
      await painted()
      check(
        hasPixels() && full()?.classList.contains('opacity-0'),
        'Medium preview disappeared before full-resolution decode completed'
      )
      check(
        dimensions() === originalDimensions,
        'Pending full-resolution decode changed original zoom dimensions'
      )
    }
    releaseDecode()
    await until(
      () => full()?.classList.contains('opacity-100') ?? false,
      'Decoded full-resolution overlay did not paint'
    )
    await painted()
    check(hasPixels(), 'Medium preview disappeared during full-resolution decode')
    check(
      dimensions() === originalDimensions,
      'Full-resolution handoff changed original zoom dimensions'
    )
    usePreviewStore.getState().controls!.zoomTo(null)
    await painted()
    check(hasPixels() && !full(), 'Returning to Fit did not restore the medium-only view')
    return {
      mediumPixelsStable: true,
      noFullImageAtFit: true,
      originalDimensionsStable: true,
      pendingDecodeObserved,
      syntheticDecodeCompletionDelayPaintCycles: 3,
      originalDimensions
    }
  } finally {
    releaseDecode()
    HTMLImageElement.prototype.decode = originalDecode
  }
}

async function stressFilmstrip(files: X3FFileDTO[], direction: 'forward' | 'revisit') {
  const inputs: number[] = []
  const starts: number[] = []
  const frameGaps: number[] = []
  const writes: Promise<void>[] = []
  let previousFrame: number | undefined
  let frame = 0
  let maxRenderedCells = 0
  const sampleFrame = (time: number): void => {
    if (previousFrame !== undefined) frameGaps.push(time - previousFrame)
    previousFrame = time
    frame = requestAnimationFrame(sampleFrame)
  }
  frame = requestAnimationFrame(sampleFrame)
  const start = performance.now()
  try {
    for (let index = 0; index < 20; index++) {
      await wait(Math.max(0, start + index * 50 - performance.now()))
      const surface = document.querySelector<HTMLElement>('[data-filmstrip]')?.parentElement
      check(surface, 'Filmstrip DOM is missing')
      const expected = files[direction === 'forward' ? index + 1 : 19 - index]
      const mode = SCOPE_MODES[index % SCOPE_MODES.length]
      const began = performance.now()
      starts.push(began)
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: direction === 'forward' ? 'ArrowRight' : 'ArrowLeft',
          bubbles: true
        })
      )
      // This is the same action the native scope menu dispatches. Popup selection
      // itself is covered separately; this measures its renderer/persistence work.
      writes.push(useSettingsStore.getState().update({ inspectorScopeMode: mode }))
      await painted()
      inputs.push(performance.now() - began)
      check(
        useQueueStore.getState().activeId === expected.id,
        'Rapid navigation lost the latest selection'
      )
      check(
        document.querySelector('aside span[title]')?.textContent ===
          `${t('inspector.title')} - ${expected.fileName}`,
        'Inspector painted stale file data'
      )
      const control = document.querySelector(
        `button[aria-label="${CSS.escape(t('inspector.scope_view'))}"]`
      )
      check(
        control?.textContent?.includes(t(`inspector.scope_${mode}`)),
        'Scope control painted a stale selection'
      )
      const rendered = document.querySelectorAll('[data-filmstrip] [title]').length
      maxRenderedCells = Math.max(maxRenderedCells, rendered)
      check(rendered > 0 && rendered < 100, 'Filmstrip failed to virtualize its 1,000 entries')
    }
    await Promise.all(writes)
    const inputToPaint = timings(inputs)
    check(
      inputToPaint.p95Ms <= 50,
      `${direction} input-to-paint p95 exceeded 50 ms: ${JSON.stringify(inputToPaint)}`
    )
    return {
      iterations: 20,
      requestedIntervalMs: 50,
      actualDispatchIntervals: timings(
        starts.slice(1).map((value, index) => value - starts[index])
      ),
      inputToPaint,
      inputToPaintP95BudgetMs: 50,
      frameGaps: timings(frameGaps),
      maxRenderedCells,
      finalSelectionCorrect: true,
      controlInvocation: 'Scope menu settings action; native popup clicks are not automated',
      inputToPaintMethod:
        'Dispatch to second requestAnimationFrame; conservative paint opportunity estimate'
    }
  } finally {
    cancelAnimationFrame(frame)
  }
}

function watchPreviewRequests() {
  const original = window.fetch
  const requests = {
    full: { started: 0, inFlight: 0, maxInFlight: 0 },
    preview: { started: 0, inFlight: 0, maxInFlight: 0 }
  }
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    const variant = url.searchParams.get('v')
    const entry =
      url.href.includes('x3f-preview') && (variant === 'full' || variant === 'preview')
        ? requests[variant]
        : undefined
    if (entry) {
      entry.started++
      entry.inFlight++
      entry.maxInFlight = Math.max(entry.maxInFlight, entry.inFlight)
    }
    try {
      return await original.call(window, input, init)
    } finally {
      if (entry) entry.inFlight--
    }
  }
  return {
    requests,
    stop: () => {
      window.fetch = original
    }
  }
}

async function checkLayout() {
  const edge = (name: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(
      `[role="separator"][aria-label="${CSS.escape(name)}"]`
    )
    check(element, `Missing resize control: ${name}`)
    return element
  }
  const reset = (element: HTMLElement): void => {
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  }
  const resize = async (element: HTMLElement): Promise<void> => {
    const before = Number(element.getAttribute('aria-valuenow'))
    const key = before >= Number(element.getAttribute('aria-valuemax')) ? 'Home' : 'End'
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await painted()
    check(
      Number(element.getAttribute('aria-valuenow')) !== before,
      'Resize did not update the layout'
    )
  }
  await useSettingsStore.getState().update({ queueViewMode: 'list' })
  await until(() => !!document.querySelector('.file-queue'), 'List view did not mount')
  await until(
    () => !!document.querySelector('.file-queue canvas.opacity-100'),
    'List thumbnail did not paint'
  )
  const name = edge(t('layout.resize_column', { name: t('queue.column.name') }))
  await resize(name)
  reset(name)
  await painted()
  const rows = document.querySelectorAll<HTMLElement>('.file-queue-row')
  check(
    rows.length > 1 &&
      getComputedStyle(rows[0]).gridTemplateColumns ===
        getComputedStyle(rows[1]).gridTemplateColumns,
    'Column headers and rows are misaligned'
  )
  for (const index of [1, 2]) {
    const heading = rows[0].children[index].querySelector('button > span')!
    const text = document.createRange()
    text.selectNodeContents(rows[1].children[index])
    check(
      Math.abs(heading.getBoundingClientRect().left - text.getBoundingClientRect().left) < 1,
      'Date/Size values are not aligned with their column titles'
    )
  }
  check(
    Number(name.getAttribute('aria-valuenow')) < 2000,
    'Column double-click did not fit contents'
  )
  const info = edge(t('layout.resize_panel', { name: t('inspector.title') }))
  await resize(info)
  reset(info)
  await painted()
  check(
    document.querySelector('aside')?.getBoundingClientRect().width === 300,
    'Info panel did not reset'
  )
  useQueueStore.getState().openExport()
  await until(() => !!document.querySelector('button svg.lucide-info'), 'Export help did not mount')
  const panel = edge(t('layout.resize_panel', { name: t('export.settings_heading') }))
  await resize(panel)
  reset(panel)
  await painted()
  check(
    document.querySelector('aside')?.getBoundingClientRect().width === 380,
    'Export panel did not reset'
  )
  const help = document.querySelector<HTMLButtonElement>('button:has(svg.lucide-info)')!
  help.focus()
  await until(() => !!document.querySelector('.export-help-tooltip'), 'Export help did not open')
  const tooltip = document.querySelector('.export-help-tooltip')!
  const supported = CSS.supports('-apple-visual-effect', '-apple-system-glass-material')
  const glass =
    document.documentElement.dataset.platform === 'darwin' &&
    supported &&
    !matchMedia('(prefers-reduced-transparency: reduce)').matches
  const style = getComputedStyle(tooltip)
  check(
    glass
      ? style.getPropertyValue('-apple-visual-effect') === '-apple-system-glass-material'
      : style.backgroundColor === 'rgb(38, 38, 38)',
    'Incorrect Export help material'
  )
  check(
    document.querySelectorAll('.app-tooltip').length === 1 &&
      !!document.querySelector('button[title]'),
    'Native title tooltips were replaced'
  )
  help.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until(() => !document.querySelector('.app-tooltip'), 'Escape did not dismiss help')
  useQueueStore.getState().cancelExport()
  await useSettingsStore.getState().update({ queueViewMode: 'filmstrip' })
  await painted()
  return {
    columnResizeAndFit: true,
    alignedColumns: true,
    thumbnail: true,
    panelResizeAndReset: true,
    exportHelpGlass: glass,
    nativeTitles: true
  }
}

async function run(input: string): Promise<Record<string, unknown>> {
  check(
    location.protocol === 'tauri:' || location.hostname === 'tauri.localhost',
    'Use embedded assets with test:native -- --build'
  )
  await until(
    () => useSettingsStore.getState().loaded && !!document.querySelector('#root button'),
    'React/settings did not initialize'
  )
  const original = { ...useSettingsStore.getState().settings }
  try {
    await useSettingsStore.getState().update({
      queueViewMode: 'filmstrip',
      inspectorOpen: true,
      inspectorScopeMode: 'waveform',
      sortField: 'File Name',
      sortAscending: true
    })
    useQueueStore.getState().clearQueue()
    const importStart = performance.now()
    await useQueueStore.getState().addFiles([input])
    const importMilliseconds = performance.now() - importStart
    const file = useQueueStore.getState().files[0]
    check(
      file && !file.pending && file.path === input && file.fileSize,
      'Renderer import did not hydrate the real source'
    )
    check(Array.isArray(file.exif), 'Import did not include inspector metadata')
    await until(
      () => !!document.querySelector('[data-filmstrip] [title]'),
      'Imported file did not reach the filmstrip DOM'
    )
    const previews = []
    for (const variant of ['preview', 'full'] as const)
      previews.push(await checkPreview(file, variant))
    const worker = await checkScopeWorker()
    const fitWorker = await checkFitWorker()
    const fitHandoff = await checkFitHandoff()
    const layout = await checkLayout()
    const revision = crypto.randomUUID()
    const files = Array.from({ length: 1000 }, (_, index) => ({
      ...file,
      id: `smoke-${revision}-${index}`,
      fileName: `Synthetic ${String(index).padStart(4, '0')}.X3F`
    }))
    const watched = watchPreviewRequests()
    let forward: Awaited<ReturnType<typeof stressFilmstrip>>
    let revisit: Awaited<ReturnType<typeof stressFilmstrip>>
    try {
      useQueueStore.setState({ files, selectedIds: new Set([files[0].id]), activeId: files[0].id })
      await painted()
      forward = await stressFilmstrip(files, 'forward')
      revisit = await stressFilmstrip(files, 'revisit')
      check(
        watched.requests.full.started > 0 && watched.requests.preview.started > 0,
        'Synthetic navigation did not exercise native preview requests'
      )
      check(
        watched.requests.full.maxInFlight <= 1,
        'Full preview extraction backlog exceeded one active request'
      )
      check(
        watched.requests.preview.maxInFlight <= 3,
        'Small preview extraction exceeded three active requests'
      )
    } finally {
      watched.stop()
    }
    const scopeLabel = t(
      `inspector.scope_${useSettingsStore.getState().settings.inspectorScopeMode}`
    )
    await until(
      () =>
        !!document.querySelector(
          `aside canvas[role="img"][aria-label="${CSS.escape(scopeLabel)}"]:not([aria-hidden="true"])`
        ),
      'Final scope did not paint'
    )
    return {
      ok: true,
      url: location.href,
      app: await ipc.invoke('app:info'),
      realImport: {
        fileName: file.fileName,
        fileSize: file.fileSize,
        exifRows: file.exif.length,
        milliseconds: importMilliseconds,
        previews
      },
      scopeWorker: worker,
      fitPreview: { worker: fitWorker, handoff: fitHandoff },
      layout,
      filmstrip: {
        synthetic: true,
        rows: files.length,
        uniqueSourceFiles: 1,
        forward,
        revisit,
        previewRequests: {
          ...watched.requests,
          method:
            'Native preview fetch calls until response headers; distinct synthetic revisions reuse one source file'
        }
      },
      limitations:
        'Synthetic rows reuse one source. This is a renderer/native-webview stress check, not a 1,000-file cold-import or Merrill/Quattro corpus benchmark. No before-change native baseline was recorded.'
    }
  } finally {
    useQueueStore.getState().clearQueue()
    await useSettingsStore.getState().update(original)
  }
}

/** Included only by an explicit VITE_NATIVE_SMOKE=1 build; Rust invokes it only in Debug. */
export function installNativeSmoke(): void {
  window.__x3fRunNativeSmoke = run
}
