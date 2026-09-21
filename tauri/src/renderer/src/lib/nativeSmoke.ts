import { previewUrl } from '@shared/preview'
import { SCOPE_MODES, type X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { usePreviewStore } from '../stores/previewStore'
import { ipc } from './ipc'
import { useEditorStore } from '../stores/editorStore'
import { useNavStore } from '../stores/navStore'
import { t } from './strings'

declare global {
  interface Window {
    __x3fRunNativeSmoke?: (input: string, editor?: boolean) => Promise<Record<string, unknown>>
    __x3fSmokeProgress?: string
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const painted = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Webview did not paint: ${document.visibilityState}, focused=${document.hasFocus()}`
          )
        ),
      5000
    )
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
      })
    )
  })
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function until(predicate: () => boolean, message: string, timeout = 15000): Promise<void> {
  window.__x3fSmokeProgress = message
  const deadline = performance.now() + timeout
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
  window.__x3fRunNativeSmoke = (input, editor = false) => (editor ? runEditor(input) : run(input))
}

/** The launcher copies the RAW to a temporary folder before enabling this test. */
async function runEditor(input: string): Promise<Record<string, unknown>> {
  window.__x3fSmokeProgress = 'Loading editor settings'
  await useSettingsStore.getState().load()
  const original = { ...useSettingsStore.getState().settings }
  const e = useEditorStore.getState
  const q = useQueueStore.getState
  const previewReady = (): boolean => !!e().preview && !e().rendering && !e().loading
  const previewPainted = (): boolean => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-rendered-preview]')
    return !!canvas?.width && canvas.dataset.previewUrl === e().preview?.url
  }
  const tilePainted = (): boolean => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-editor-tile]')
    return !!canvas?.width && canvas.dataset.previewUrl === e().tile?.url
  }
  const monochromePixels = (): string => {
    const source = document.querySelector<HTMLCanvasElement>('canvas[data-rendered-preview]')!
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    const context = canvas.getContext('2d')!
    context.drawImage(source, 0, 0, 16, 16)
    const pixels = context.getImageData(0, 0, 16, 16).data
    for (let i = 0; i < pixels.length; i += 4)
      check(
        Math.abs(pixels[i] - pixels[i + 1]) <= 2 && Math.abs(pixels[i] - pixels[i + 2]) <= 2,
        'Monochrome preview contains colored pixels'
      )
    check(
      pixels.some((v, i) => i % 4 === 0 && v > 20 && v < 235),
      'Monochrome preview lost all midtones'
    )
    return pixels.join(',')
  }
  const button = (label: string): HTMLButtonElement => {
    const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label
    )
    check(element, `Missing editor button: ${label}`)
    return element
  }
  try {
    await useSettingsStore.getState().update({ queueViewMode: 'filmstrip', inspectorOpen: false })
    await q().addFiles([input])
    const file = q().files[0]
    check(file && !file.pending, 'Editor import did not complete')
    q().setSelection(new Set([file.id]), file.id)
    await painted()
    const opened = performance.now()
    button(t('editor.edit')).click()
    await until(previewReady, 'Initial RAW preview did not complete', 60000)
    check(useNavStore.getState().screen === 'editor', 'Edit did not open in the main window')
    check(!e().error, e().error ?? 'Editor failed')
    const firstPreviewMs = performance.now() - opened
    const initial = e().preview!
    check(e().session!.recipe.film !== null, 'Film rendering is not enabled by default')
    check(
      JSON.stringify(e().session!.recipe.crop) === JSON.stringify(e().session!.asShotCrop),
      'Initial crop does not use camera framing'
    )
    await until(previewPainted, 'Initial GPU frame did not paint', 15000)
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = initial.url
    window.__x3fSmokeProgress = 'Decoding initial editor image'
    await image.decode()
    check(
      image.naturalWidth > 0 && image.naturalHeight > 0,
      'Edited custom-protocol PNG did not decode under CSP'
    )
    check(initial.fullWidth && initial.fullHeight, 'Native RAW dimensions were not returned')
    const exposure = document.querySelector<HTMLInputElement>(
      `input[aria-label="${CSS.escape(t('editor.evFilm'))}"]`
    )
    check(exposure, 'Accessible exposure control is missing')
    const changed = performance.now()
    e().change({ film: { ...e().documents[e().session!.path].recipe.film!, evFilm: 1 } }, false)
    e().commit()
    check(await e().flush(), 'Autosave failed')
    await until(
      () => previewReady() && e().preview!.url !== initial.url && previewPainted(),
      'Exposure did not update the RAW preview',
      60000
    )
    const adjustmentMs = performance.now() - changed
    const path = e().session!.path
    check(e().documents[path].past.length === 1, 'One gesture produced more than one undo step')
    button(t('editor.undo')).click()
    check(e().documents[path].recipe.film?.evFilm === 0, 'Undo did not restore exposure')
    await painted()
    button(t('editor.redo')).click()
    check(e().documents[path].recipe.film?.evFilm === 1, 'Redo did not restore the adjustment')
    check(await e().flush(), 'History autosave failed')
    const loaded = await ipc.invoke('editor:load', { paths: [input] })
    check(loaded[0]?.recipe?.film?.evFilm === 1, 'Saved sidecar did not reload')
    await until(previewReady, 'History render did not complete', 60000)
    const inputToPaint: number[] = []
    for (let index = 0; index < 12; index++) {
      window.__x3fSmokeProgress = `Painting slider input ${index}`
      await painted()
      const previous = e().preview!.url
      const value = e().documents[path].recipe.film!.evFilm
      const knob = document.querySelector<HTMLElement>(
        `[role="slider"][aria-label="${CSS.escape(t('editor.evFilm'))}"]`
      )
      check(knob, 'Film exposure slider knob is missing')
      const began = performance.now()
      knob.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      check(e().documents[path].recipe.film!.evFilm > value, 'Film slider did not change exposure')
      await until(
        () => e().preview?.url !== previous && previewPainted(),
        'Interactive film frame did not paint',
        15000
      )
      await painted()
      inputToPaint.push(performance.now() - began)
    }
    const knob = document.querySelector<HTMLElement>(
      `[role="slider"][aria-label="${CSS.escape(t('editor.evFilm'))}"]`
    )!
    knob.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    check(e().documents[path].recipe.film!.evFilm === 0, 'Double-click did not reset film exposure')
    e().change({ film: { ...e().documents[path].recipe.film!, evFilm: 1 } })
    check(await e().flush(), 'Benchmark adjustment autosave failed')
    await until(() => previewReady() && previewPainted(), 'Latest adjustment did not paint', 15000)
    await until(
      () => (e().preview?.width ?? 0) > 512 && previewPainted(),
      'Idle preview did not refine',
      15000
    )
    const monochrome = document.querySelector<HTMLButtonElement>(
      `[role="switch"][aria-label="${CSS.escape(t('editor.monochrome'))}"]`
    )
    check(monochrome, 'Monochrome switch is missing')
    monochrome.click()
    check(e().documents[path].recipe.monochrome?.filter === 'neutral', 'Monochrome did not enable')
    let previous = e().preview!.url
    e().change({ monochrome: { filter: 'red' } })
    await until(
      () => e().preview?.url !== previous && previewPainted(),
      'Red monochrome filter did not paint'
    )
    const redPixels = monochromePixels()
    previous = e().preview!.url
    e().change({ monochrome: { filter: 'blue' } })
    await until(
      () => e().preview?.url !== previous && previewPainted(),
      'Blue monochrome filter did not paint'
    )
    check(monochromePixels() !== redPixels, 'Red and blue sensor filters produced the same image')
    previous = e().preview!.url
    e().change({ monochrome: { filter: 'red' } })
    check(await e().flush(), 'Monochrome did not save')
    const monochromeSaved = await ipc.invoke('editor:load', { paths: [input] })
    check(
      monochromeSaved[0]?.recipe?.monochrome?.filter === 'red',
      'Monochrome sidecar did not reload'
    )
    await until(
      () => e().preview?.url !== previous && previewPainted(),
      'Restored monochrome filter did not paint'
    )

    usePreviewStore.getState().controls!.zoomTo(1)
    await until(
      () => {
        const tile = e().tile
        return (
          !!tile &&
          !e().rendering &&
          tilePainted() &&
          Math.abs(tile.width - (tile.fullWidth ?? 0) * tile.region.width) < 1 &&
          Math.abs(tile.height - (tile.fullHeight ?? 0) * tile.region.height) < 1
        )
      },
      'Native-resolution region did not render',
      60000
    )
    check(
      e().tile!.width > 0 && e().tile!.fullWidth === initial.fullWidth,
      'Region render lost native dimensions'
    )
    await until(
      () => !document.querySelector('.preview-image')?.getAnimations().length,
      'Zoom animation did not settle'
    )
    const panCanvas = document.querySelector<HTMLCanvasElement>('canvas[data-editor-tile]')!
    const panSurface = document.querySelector<HTMLElement>(
      `[role="region"][aria-label="${CSS.escape(t('preview.image'))}"]`
    )!
    const panStart = e().viewport!.x
    for (let index = 0; index < 8; index++) {
      panSurface.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 12, bubbles: true, cancelable: true })
      )
      await painted()
      check(
        document.querySelector('canvas[data-editor-tile]') === panCanvas,
        'Panning removed the decoded detail tile'
      )
      check(
        Math.abs(panCanvas.width - (initial.fullWidth! * parseFloat(panCanvas.style.width)) / 100) <
          1 &&
          Math.abs(
            panCanvas.height - (initial.fullHeight! * parseFloat(panCanvas.style.height)) / 100
          ) < 1,
        'Panning downgraded the tile resolution'
      )
    }
    check(e().viewport!.x > panStart, 'Native pan gesture did not move the viewport')
    await until(
      () =>
        tilePainted() &&
        !e().rendering &&
        JSON.stringify(e().tile?.viewport) === JSON.stringify(e().viewport),
      'Panned detail did not catch up with the viewport'
    )
    const basePreview = e().preview!.url
    const viewportInputToPaint: number[] = []
    for (let index = 0; index < 6; index++) {
      const previousTile = e().tile!.url
      const began = performance.now()
      knob.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await until(
        () => e().tile?.url !== previousTile && tilePainted(),
        'Zoomed adjustment did not paint'
      )
      await painted()
      viewportInputToPaint.push(performance.now() - began)
      check(e().preview!.url === basePreview, 'Zoomed adjustment rerendered the full image')
    }
    check(await e().flush(), 'Zoomed adjustment did not save')
    usePreviewStore.getState().controls!.zoomTo(null)
    await until(
      () => !e().viewport && e().preview?.url !== basePreview && previewReady() && previewPainted(),
      'Fit preview did not refresh after zoomed edits'
    )
    previous = e().preview!.url
    e().change({ film: { ...e().documents[path].recipe.film!, evFilm: 1 } })
    check(await e().flush(), 'Export adjustment did not save')
    await until(
      () => e().preview?.url !== previous && previewPainted(),
      'Export adjustment did not paint'
    )
    q().openExport(new Set([file.id]), 'editor')
    await until(
      () => useNavStore.getState().screen === 'export' && !q().isPreparing,
      'Editor export review did not open',
      60000
    )
    check(q().draft?.returnScreen === 'editor', 'Export review lost its editor return route')
    check(q().draft?.files[0].edit?.recipe.film?.evFilm === 1, 'Export recipe was not captured')
    check(
      q().draft?.files[0].edit?.recipe.monochrome?.filter === 'red',
      'Monochrome export recipe was not captured'
    )
    // The launcher copied the RAW to a disposable directory. Keep exports there
    // regardless of the user's remembered destination or existing output files.
    q().updateDraft({ outputFormat: 'jpeg', rendering: 'rendered', outputDirectory: null })
    const beganExport = performance.now()
    await q().commitExport()
    await until(() => !!q().batch?.summary, 'Edited JPEG export did not finish', 60000)
    check(q().batch!.summary!.completed === 1, `Edited export failed: ${JSON.stringify(q().batch)}`)
    const jpegExportMs = performance.now() - beganExport
    check(useNavStore.getState().screen === 'editor', 'Export did not return to the editor')
    check(await e().close(), 'Back to Main failed to save the editor')
    check(useNavStore.getState().screen === 'queue', 'Back to Main did not restore browsing')
    check(q().files[0].edit?.recipe.film?.evFilm === 1, 'Main view lost saved edits')
    q().openExport(new Set([file.id]))
    await until(
      () => useNavStore.getState().screen === 'export' && !q().isPreparing,
      'Main export review failed',
      60000
    )
    check(
      q().draft?.files[0].edit?.recipe.film?.evFilm === 1,
      'Main export did not use the saved edit'
    )
    q().cancelExport()
    return {
      ok: true,
      editor: {
        firstPreviewMs,
        adjustmentMs,
        inputToPaint: timings(inputToPaint),
        viewportInputToPaint: timings(viewportInputToPaint),
        viewportOnlyAdjustments: true,
        panningKeepsDetail: true,
        monochromeFilters: true,
        interactiveMaxEdge: 512,
        idleRefinement: true,
        sliderReset: true,
        filmDefault: true,
        asShotCrop: true,
        jpegExportMs,
        width: initial.fullWidth,
        height: initial.fullHeight,
        storage: loaded[0].storage,
        nativeRegion: true,
        undoRedo: true,
        sidecarReload: true,
        bothExportEntryPoints: true
      },
      app: await ipc.invoke('app:info')
    }
  } finally {
    window.__x3fSmokeProgress = 'Closing editor and restoring smoke settings'
    await e().close()
    q().clearQueue()
    await useSettingsStore.getState().update(original)
  }
}
