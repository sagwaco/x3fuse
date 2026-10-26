import { create } from 'zustand'
import {
  capabilitiesOf,
  FOVEON_CAPABILITIES,
  hasWhiteBalance,
  pasteRecipe,
  pixelRecipe,
  sourceDefaultRecipe,
  supportedRecipe,
  usesSfd,
  usesExtendedWhiteBalance,
  type EditRecipe,
  type EditRecord,
  type EditorSession,
  type RenderedPreview,
  type PreviewRegion,
  type SourceCapabilities,
  type X3iStatus
} from '@shared/editor'
import type { X3FFileDTO } from '@shared/types'
import { ipc } from '../lib/ipc'
import { isNative, nextPrefetch, MAX_RENDERS, type PreviewCache } from '../lib/previewTiles'
import { useQueueStore } from './queueStore'
import { useNavStore } from './navStore'
import { qualifyMix } from '../lib/qualifyMix'
import { t } from '../lib/strings'

interface Document extends EditRecord {
  past: EditRecipe[]
  future: EditRecipe[]
  gesture?: EditRecipe
  dirty: boolean
  error?: string
}
interface EditorState {
  session: EditorSession | null
  documents: Record<string, Document>
  loading: boolean
  closing: boolean
  rendering: boolean
  /** True when the current photo's foreground render failed. The next render clears it. */
  renderFailed: boolean
  error: string | null
  mixNotice: string | null
  preview: RenderedPreview | null
  /** The demosaic of the last accepted non-draft render, including viewport tiles. */
  renderedDemosaic: EditRecipe['dngDemosaic']
  /** The pitch and yaw `preview` was rendered with; analysis must not use it with other angles. */
  previewPose: { pitch: number; yaw: number } | null
  /** The `geometryKey` of the recipe that `preview` was rendered with. */
  previewGeometry: string | null
  before: boolean
  /** The current white balance control mode, used by the neutral picker. */
  whiteBalanceExtended: boolean
  /** Show a negative print inverted, as a positive. Only the view changes. */
  negativePreview: boolean
  cropping: boolean
  viewport: PreviewRegion | null
  /** The render key of `preview`; while zoomed, prefetch refreshes it when it is stale. */
  previewKey: string | null
  tile: (RenderedPreview & { region: PreviewRegion; viewport: PreviewRegion }) | null
  /** Sharp renders of the current recipe around the viewport; see lib/previewTiles. */
  cache: PreviewCache | null
  /** Idle prefetch is rendering; look thumbnails wait for it. */
  prefetching: boolean
  /** Forget a cached render whose pixels could not be shown. */
  uncache: (url: string) => void
  setViewport: (region: PreviewRegion | null) => void
  /** Call while the view moves. Prefetch waits until the view rests. */
  holdPrefetch: () => void
  setCropping: (cropping: boolean) => void
  clipboard: EditRecipe | null
  /** The capabilities of the photo that `clipboard` came from. Missing means a Foveon file. */
  clipboardCapabilities?: SourceCapabilities
  open: (file: X3FFileDTO) => Promise<void>
  change: (patch: Partial<EditRecipe>, commit?: boolean) => void
  commit: () => void
  undo: () => void
  redo: () => void
  reset: () => void
  compare: (before: boolean) => void
  /** Copies the saved adjustments of `file`, else of the open photo or the active photo. */
  copy: (file?: X3FFileDTO) => void
  paste: (files?: X3FFileDTO[]) => Promise<void>
  flush: () => Promise<boolean>
  close: () => Promise<boolean>
  render: (navigation?: boolean) => void
  pickWhiteBalance: (x: number, y: number) => Promise<void>
  pickRawMix: (x: number, y: number, output: 0 | 1 | 2) => Promise<void>
  /** A small look preview, rendered only while the editor is idle; edits preempt it. */
  renderThumbnail: (recipe: EditRecipe) => Promise<string | null>
  /** The merge state of an open X3I. Its SFD RAW renders only after its frames merge. */
  x3i: X3iStatus | null
  /** The open X3I changes between its SFD RAW and its unfused RAW, and the
      changed photo did not render yet. */
  switching: boolean
  /** Starts the merge of the open X3I. The merge continues after the photo closes.
      A photo that uses its unfused RAW uses the SFD RAW when the merge ends. */
  processX3i: () => void
  cancelX3i: () => void
  /** Removes the SFD RAW of the open X3I. The photo then uses its unfused RAW. */
  deleteX3i: () => void
  /** Reads the merge state again, and renders when the merge is done. A poll
      skips while a read is in flight; other reads wait for it. */
  refreshX3i: (poll?: boolean) => Promise<void>
}

const same = (a: EditRecipe, b: EditRecipe): boolean => JSON.stringify(a) === JSON.stringify(b)
/** The settings that move pixels: crop, rotation, straighten and perspective. */
export const geometryKey = (recipe: EditRecipe): string =>
  JSON.stringify([recipe.crop, recipe.rotation, recipe.straighten, recipe.pitch, recipe.yaw])
const sameGeometry = (a: EditRecipe, b: EditRecipe): boolean => geometryKey(a) === geometryKey(b)
const sameRegion = (a: PreviewRegion | null, b: PreviewRegion | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b)
const saves = new Set<Promise<void>>()
let colorPick = 0
let opening = 0
let renderRevision = 0
let renderTimer: ReturnType<typeof setTimeout> | undefined
let renderRunning = false
let renderPending = false
let navigationPending = false
let refining = false
let refinementPending = false
let refinementTimer: ReturnType<typeof setTimeout> | undefined
let cancellationSent = false
let runningRevision = 0
let prefetchTimer: ReturnType<typeof setTimeout> | undefined
let prefetchRunning = false
let prefetchMisses = { key: '', regions: new Set<string>() }
let thumbnailsRunning = 0
let movedAt = -Infinity
/** The X3I whose merge the user cancelled last; its failure is not an error. */
let cancelledX3i: string | null = null
/** X3I files whose merge request is in flight. Their status shows progress before the merge reports it. */
const merging = new Set<string>()
/** The X3I whose merge started from its unfused RAW. It uses the SFD RAW once a
    status read first reports it, unless a change cannot apply then, as in Before. */
let mergeSwitch: string | null = null
/** Status reads run one at a time, in order. */
let refreshing: Promise<void> = Promise.resolve()
let refreshBusy = false
/** True when the open X3I cannot render `recipe` before its frames merge. */
const waitsForMerge = (state: EditorState, recipe: EditRecipe | undefined): boolean =>
  !!state.x3i && !state.x3i.processed && usesSfd(recipe)
/** True when `to` changes the frames that the open X3I renders, and it can render them. */
const switchesFrames = (state: EditorState, from: EditRecipe, to: EditRecipe): boolean =>
  !!state.x3i && usesSfd(from) !== usesSfd(to) && !waitsForMerge(state, to)
/** An open X3I that uses its SFD RAW renders only after its frames merge. */
export const needsX3iMerge = (state: EditorState): boolean =>
  waitsForMerge(state, state.session ? state.documents[state.session.path]?.recipe : undefined)
const unmerged = needsX3iMerge
/** Without its SFD RAW, an X3I blocks edits, except a change to its unfused RAW. */
const blocked = (state: EditorState, recipe: EditRecipe): boolean =>
  unmerged(state) && waitsForMerge(state, recipe)
const INTERACTIVE_EDGE = 1024
const REFINE_DELAY = 100
// Longer than LookPicker's 250 ms wait, so look thumbnails render first.
const PREFETCH_DELAY = 400

function updateQueue(path: string, edit: EditRecord): void {
  useQueueStore.setState((state) => ({
    files: state.files.map((file) =>
      file.path === path
        ? // A photo back at its defaults is not edited: no badge, camera defaults on export.
          { ...file, edit: edit.edited === false ? undefined : edit, editError: undefined }
        : file
    )
  }))
}

// A hue that a wheel keeps at zero strength changes no pixels, so it is not in the key.
const renderKey = (sessionId: string, recipe: EditRecipe): string =>
  `${sessionId}:${JSON.stringify(pixelRecipe(recipe))}`

/** The capabilities of the photo at `path`: the open photo, else a queue file. */
function capabilitiesFor(path: string): SourceCapabilities {
  const session = useEditorStore.getState().session
  if (session?.path === path) return capabilitiesOf(session)
  return capabilitiesOf(
    useQueueStore.getState().files.find((file) => file.path === path) ?? { path }
  )
}

/** The recipe that Reset gives: the camera's look and framing, without adjustments.
    The photo keeps its seed and its demosaic, which is a source setting. */
export function asShotRecipe(
  session: EditorSession | null,
  { seed, dngDemosaic }: Pick<EditRecipe, 'seed' | 'dngDemosaic'>
): EditRecipe {
  const capabilities = session ? capabilitiesOf(session) : FOVEON_CAPABILITIES
  return supportedRecipe(
    {
      ...sourceDefaultRecipe(capabilities),
      film: null,
      cameraProfile: session?.asShotCameraProfile ?? null,
      monochrome: session?.asShotCameraProfile === 'Monochrome' ? { filter: 'neutral' } : null,
      crop: session?.asShotCrop ?? null,
      seed,
      dngDemosaic
    },
    capabilities
  )
}

/** The recipe a render of the current view uses. */
function renderRecipe(state: EditorState, doc: Document): EditRecipe {
  let recipe = state.before
    ? {
        ...asShotRecipe(state.session, doc.recipe),
        crop: doc.recipe.crop,
        rotation: doc.recipe.rotation,
        straighten: doc.recipe.straighten,
        pitch: doc.recipe.pitch,
        yaw: doc.recipe.yaw,
        x3iSource: doc.recipe.x3iSource
      }
    : doc.recipe
  if (state.cropping) recipe = { ...recipe, crop: null, rotation: 0, straighten: 0 }
  // Sensor denoising requires fresh RAW preparation. Coalesce slider moves and do it
  // once on commit; other controls keep using the already prepared source.
  if (doc.gesture)
    recipe = {
      ...recipe,
      denoise: doc.gesture.denoise,
      denoiseOptions: doc.gesture.denoiseOptions
    }
  return recipe
}

/**
 * True when `preview` shows the current recipe. While zoomed, an edit renders the tile
 * first, and idle prefetch refreshes the whole-image preview later.
 */
export function previewCurrent(state: EditorState): boolean {
  const doc = state.session && state.documents[state.session.path]
  return !!doc && state.previewKey === renderKey(state.session!.sessionId, renderRecipe(state, doc))
}

export const useEditorStore = create<EditorState>((set, get) => {
  function document(file: X3FFileDTO): Document {
    return (
      get().documents[file.path] ?? {
        recipe: structuredClone(
          supportedRecipe(
            file.edit?.recipe ?? sourceDefaultRecipe(capabilitiesOf(file)),
            capabilitiesOf(file)
          )
        ),
        revision: file.edit?.revision ?? 0,
        storage: file.edit?.storage ?? 'none',
        sourceRevision: file.edit?.sourceRevision,
        past: [],
        future: [],
        dirty: false
      }
    )
  }
  function save(path: string): void {
    const doc = get().documents[path]
    if (!doc) return
    const { recipe, revision } = doc
    // Send committed adjustments immediately so native close can flush accepted work.
    const work = ipc
      .invoke('editor:save', { path, recipe, revision, sourceRevision: doc.sourceRevision })
      .then((saved) => {
        const current = get().documents[path]
        if (!current || current.revision !== revision) return
        set((state) => ({
          documents: {
            ...state.documents,
            [path]: {
              ...current,
              storage: saved.edited === false ? 'none' : saved.storage,
              storagePath: saved.storagePath,
              previewUrl: saved.previewUrl,
              sourceRevision: saved.sourceRevision,
              dirty: false,
              error: undefined
            }
          }
        }))
        updateQueue(path, saved)
      })
      .catch((error: unknown) => {
        const current = get().documents[path]
        if (!current || current.revision !== revision) return
        set((state) => ({
          error: String(error),
          documents: {
            ...state.documents,
            [path]: { ...current, dirty: true, error: String(error) }
          }
        }))
      })
      .finally(() => saves.delete(work))
    saves.add(work)
  }
  function publish(path: string, doc: Document): void {
    // Undo, redo, and paste apply only the settings that the photo supports.
    doc = { ...doc, recipe: supportedRecipe(doc.recipe, capabilitiesFor(path)) }
    set((state) => {
      const geometryChanged =
        state.session?.path === path && !sameGeometry(state.documents[path].recipe, doc.recipe)
      return {
        documents: { ...state.documents, [path]: doc },
        error: null,
        before: false,
        cache: null,
        // A photo that waits for a merge does not render, so it does not switch.
        switching:
          state.session?.path !== path
            ? state.switching
            : !waitsForMerge(state, doc.recipe) &&
              (state.switching || switchesFrames(state, state.documents[path].recipe, doc.recipe)),
        ...(geometryChanged ? { viewport: null, tile: null } : state.before ? { tile: null } : {})
      }
    })
    save(path)
    get().render()
  }
  async function runRender(): Promise<void> {
    if (get().closing || renderRunning || (!renderPending && !refinementPending)) return
    const state = get()
    if (!state.session || state.loading || unmerged(state) || useQueueStore.getState().isProcessing)
      return
    const doc = state.documents[state.session.path]
    if (!doc) return
    // Without a preview on screen, as on open or a crop mode change, a fast
    // frame shows only until its refinement replaces it. Refine at once.
    const detail = !renderPending || (!state.preview && !doc.gesture)
    const navigation = navigationPending
    renderPending = false
    navigationPending = false
    refinementPending = false
    if (detail && doc.gesture) return
    renderRunning = true
    refining = detail || navigation
    cancellationSent = false
    const revision = renderRevision
    runningRevision = revision
    const sessionId = state.session.sessionId
    const recipe = renderRecipe(state, doc)
    const key = renderKey(sessionId, recipe)
    const region = !state.cropping ? state.viewport : null
    set({
      rendering: true,
      renderFailed: false,
      ...(state.cache && state.cache.key !== key ? { cache: null } : {})
    })
    try {
      const preview = await ipc.invoke('editor:render', {
        sessionId,
        recipe,
        revision,
        interactive: !detail,
        maxEdge: (detail || navigation) && region ? 4096 : detail ? 2048 : INTERACTIVE_EDGE,
        ...(region ? { region } : {})
      })
      const current = get()
      const currentDoc = current.session && current.documents[current.session.path]
      // During an active drag, paint completed intermediate frames instead of
      // starving the display until pointer-up. Geometry/mode changes stay strict.
      const currentViewport = current.cropping ? null : current.viewport
      const matchingView = sameRegion(currentViewport, region)
      const progressing =
        !detail &&
        doc.gesture &&
        currentDoc?.gesture === doc.gesture &&
        sameGeometry(currentDoc.recipe, doc.recipe) &&
        current.before === state.before &&
        current.cropping === state.cropping &&
        revision > ((region ? current.tile : current.preview)?.revision ?? -1)
      if (
        !current.closing &&
        !current.loading &&
        current.session?.sessionId === sessionId &&
        preview.sessionId === sessionId &&
        preview.revision === revision &&
        matchingView &&
        (renderRevision === revision || progressing)
      ) {
        set({
          ...(region
            ? { tile: { ...preview, region: preview.region ?? region, viewport: region } }
            : {
                preview,
                previewKey: preview.draft ? null : key,
                previewPose: { pitch: recipe.pitch, yaw: recipe.yaw },
                previewGeometry: geometryKey(recipe)
              }),
          ...(!preview.draft && { renderedDemosaic: recipe.dngDemosaic ?? null }),
          switching: false,
          error: Object.values(get().documents).find((doc) => doc.error)?.error ?? null
        })
      }
      if (region && !preview.draft && preview.sessionId === sessionId) {
        // Keep sharp pixels even when the view moved on during the render.
        if (isNative(preview)) cacheRender(key, preview)
        if ((detail || navigation) && renderRevision === revision) schedulePrefetch()
      }
      if (
        !detail &&
        (!navigation || preview.draft) &&
        renderRevision === revision &&
        !get().documents[state.session.path]?.gesture
      ) {
        clearTimeout(refinementTimer)
        refinementTimer = setTimeout(() => {
          if (renderRevision !== revision || get().session?.sessionId !== sessionId) return
          refinementPending = true
          void runRender()
        }, REFINE_DELAY)
      }
    } catch (error) {
      if (get().session?.sessionId === sessionId && renderRevision === revision)
        set({ switching: false })
      // An X3I whose SFD RAW is gone waits for its merge again.
      if (get().x3i) await get().refreshX3i()
      if (
        get().session?.sessionId === sessionId &&
        renderRevision === revision &&
        !get().closing &&
        !get().loading &&
        !unmerged(get())
      )
        set({ error: String(error), renderFailed: true })
    } finally {
      renderRunning = false
      refining = false
      if (!renderPending && !refinementPending) set({ rendering: false })
      else void runRender()
    }
  }
  function currentKey(): string | null {
    const state = get()
    const doc = state.session && state.documents[state.session.path]
    return doc ? renderKey(state.session!.sessionId, renderRecipe(state, doc)) : null
  }
  function cacheRender(key: string, preview: RenderedPreview): void {
    if (key !== currentKey() || get().cropping || !preview.region) return
    const region = preview.region
    set(({ cache }) => {
      const current =
        cache?.key === key
          ? cache
          : { key, width: preview.fullWidth!, height: preview.fullHeight!, renders: [] }
      return {
        cache: {
          ...current,
          // One recipe and region give the same pixels: keep the newest render of each.
          renders: [
            ...current.renders.filter(
              (render) => render.url !== preview.url && !sameRegion(render.region, region)
            ),
            { url: preview.url, region }
          ].slice(-MAX_RENDERS)
        }
      }
    })
  }
  function schedulePrefetch(delay = PREFETCH_DELAY): void {
    clearTimeout(prefetchTimer)
    prefetchTimer = setTimeout(() => void prefetch(), delay)
  }
  /**
   * While zoomed and idle, render the sharp cells around the viewport one block
   * at a time, then refresh a stale whole-image base. Any new render cancels it.
   *
   * ponytail: blocks only follow a native viewport render. A view wider than the
   * renderer's 4096 px region limit shows most of the photo, and native blocks
   * for it would render most of the photo again after each edit.
   */
  async function prefetch(): Promise<void> {
    // Renders during a moving view take GPU time from the compositor.
    const rest = movedAt + PREFETCH_DELAY - performance.now()
    if (rest > 0) return schedulePrefetch(rest)
    const state = get()
    const doc = state.session && state.documents[state.session.path]
    if (
      renderRunning ||
      renderPending ||
      refinementPending ||
      thumbnailsRunning ||
      state.closing ||
      state.loading ||
      unmerged(state) ||
      state.cropping ||
      !state.viewport ||
      !doc ||
      doc.gesture ||
      useQueueStore.getState().isProcessing
    )
      return
    const sessionId = state.session!.sessionId
    const recipe = renderRecipe(state, doc)
    const key = renderKey(sessionId, recipe)
    if (prefetchMisses.key !== key) prefetchMisses = { key, regions: new Set() }
    const misses = prefetchMisses.regions
    const region =
      state.cache?.key === key ? nextPrefetch(state.cache, state.viewport, misses) : null
    if (!region && (state.previewKey === key || misses.has('base'))) return
    const miss = region ? JSON.stringify(region) : 'base'
    const revision = renderRevision
    renderRunning = true
    refining = true
    prefetchRunning = true
    cancellationSent = false
    runningRevision = revision
    set({ prefetching: true })
    try {
      // Interactive: never prepare RAW again; a draft result is not kept.
      const preview = await ipc.invoke('editor:render', {
        sessionId,
        recipe,
        revision,
        interactive: true,
        maxEdge: region ? 4096 : 2048,
        ...(region ? { region } : {})
      })
      if (preview.sessionId !== sessionId || preview.draft) misses.add(miss)
      else if (region) {
        if (isNative(preview)) cacheRender(key, preview)
        else misses.add(miss)
      } else if (key === currentKey() && get().session?.sessionId === sessionId) {
        set({
          preview,
          previewKey: key,
          previewPose: { pitch: recipe.pitch, yaw: recipe.yaw },
          previewGeometry: geometryKey(recipe)
        })
      }
    } catch {
      // A newer render cancelled this one; try again later unless it failed on its own.
      if (renderRevision === revision) misses.add(miss)
    } finally {
      renderRunning = false
      refining = false
      prefetchRunning = false
      set({ prefetching: false })
      if (renderPending || refinementPending) void runRender()
      // A block that a moving view stopped tries again later.
      else schedulePrefetch(renderRevision === revision ? 0 : PREFETCH_DELAY)
    }
  }
  return {
    session: null,
    documents: {},
    loading: false,
    closing: false,
    rendering: false,
    renderFailed: false,
    error: null,
    mixNotice: null,
    preview: null,
    renderedDemosaic: null,
    previewPose: null,
    previewGeometry: null,
    before: false,
    whiteBalanceExtended: false,
    negativePreview: false,
    clipboard: null,
    cropping: false,
    viewport: null,
    previewKey: null,
    tile: null,
    cache: null,
    prefetching: false,
    x3i: null,
    switching: false,
    uncache(url) {
      set(({ cache }) =>
        cache?.renders.some((render) => render.url === url)
          ? { cache: { ...cache, renders: cache.renders.filter((render) => render.url !== url) } }
          : {}
      )
    },
    setViewport(region) {
      if (get().closing || get().loading) return
      if (region) {
        const width = Math.max(0.0001, Math.min(1, region.width))
        const height = Math.max(0.0001, Math.min(1, region.height))
        region = {
          x: Math.max(0, Math.min(1 - width, region.x)),
          y: Math.max(0, Math.min(1 - height, region.y)),
          width,
          height
        }
      }
      if (sameRegion(region, get().viewport)) return
      // Panning changes the view, not the pixels already rendered in image space.
      set({ viewport: region, ...(region ? {} : { tile: null }) })
      get().render(region !== null)
    },
    holdPrefetch() {
      movedAt = performance.now()
      // A block in flight would finish during the gesture. Stop it, as an edit
      // does. It is not a miss, so it renders again when the view rests.
      const sessionId = get().session?.sessionId
      if (!prefetchRunning || cancellationSent || !sessionId) return
      ++renderRevision
      cancellationSent = true
      void ipc
        .invoke('editor:cancelRender', { sessionId, revision: runningRevision })
        .catch(() => {})
    },
    setCropping(cropping) {
      // Crop mode would replace the SFD RAW section, and could not render to end.
      if (get().closing || get().loading || (cropping && unmerged(get()))) return
      get().commit()
      set({ cropping, viewport: null, tile: null, cache: null, preview: null, previewKey: null })
      get().render()
    },
    async open(file) {
      if (get().closing || get().loading) return
      if (file.pending || get().session?.path === file.path) return
      const token = ++opening
      set({ loading: true })
      if (!(await get().flush()) || token !== opening || get().closing) {
        if (token !== opening) return
        set({ loading: false })
        const previous = useQueueStore
          .getState()
          .files.find((item) => item.path === get().session?.path)
        if (previous) useQueueStore.getState().setSelection(new Set([previous.id]), previous.id)
        return
      }
      set({ loading: true, error: null, mixNotice: null })
      useNavStore.getState().goToEditor()
      prefetchMisses = { key: '', regions: new Set() }
      movedAt = -Infinity
      const previous = get().session
      try {
        if (previous) await ipc.invoke('editor:close', { sessionId: previous.sessionId })
        const session = await ipc.invoke('editor:open', { path: file.path })
        if (token !== opening || get().closing) {
          await ipc.invoke('editor:close', { sessionId: session.sessionId })
          return
        }
        const previousDocument = get().documents[file.path]
        // Opening removes stored defaults, so a document at its defaults keeps its history.
        const existing =
          previousDocument?.sourceRevision === session.sourceRevision &&
          (previousDocument.revision === session.revision ||
            (previousDocument.storage === 'none' && session.storage === 'none'))
            ? previousDocument
            : undefined
        const doc = existing ?? {
          ...session,
          recipe: structuredClone(supportedRecipe(session.recipe, capabilitiesOf(session))),
          past: [],
          future: [],
          dirty: false
        }
        set((state) => ({
          session,
          whiteBalanceExtended: usesExtendedWhiteBalance(doc.recipe),
          x3i: session.x3i ?? null,
          switching: false,
          documents: { ...state.documents, [file.path]: doc },
          loading: false,
          preview: null,
          renderedDemosaic: null,
          renderFailed: false,
          previewKey: null,
          before: false,
          cropping: false,
          viewport: null,
          tile: null,
          cache: null
        }))
        get().render()
      } catch (error) {
        if (token === opening)
          set({ loading: false, session: null, x3i: null, preview: null, error: String(error) })
      }
    },
    change(patch, commit = true) {
      const path = get().session?.path
      if (
        !path ||
        get().closing ||
        get().loading ||
        get().before ||
        useQueueStore.getState().isProcessing
      )
        return
      const doc = get().documents[path]
      const recipe = supportedRecipe({ ...doc.recipe, ...patch }, capabilitiesFor(path))
      // Without its SFD RAW, an X3I can still change to its unfused RAW.
      if (same(recipe, doc.recipe) || blocked(get(), recipe)) return
      // A hue that a wheel keeps at zero strength changes no pixels, so it needs no render.
      const visible = !same(pixelRecipe(recipe), pixelRecipe(doc.recipe))
      set((state) => ({
        before: false,
        ...(!!doc.recipe.rawColor !== !!recipe.rawColor && {
          whiteBalanceExtended: usesExtendedWhiteBalance(recipe)
        }),
        cache: visible ? null : state.cache,
        switching:
          !waitsForMerge(state, recipe) &&
          (state.switching || switchesFrames(state, doc.recipe, recipe)),
        ...(!sameGeometry(doc.recipe, recipe) ? { viewport: null, tile: null } : {}),
        documents: {
          ...state.documents,
          [path]: { ...doc, recipe, gesture: doc.gesture ?? doc.recipe }
        }
      }))
      if (commit) get().commit()
      else if (visible) get().render()
    },
    commit() {
      const path = get().session?.path
      if (!path) return
      const doc = get().documents[path]
      if (!doc?.gesture) return
      if (same(doc.recipe, doc.gesture)) {
        set((state) => ({
          documents: { ...state.documents, [path]: { ...doc, gesture: undefined } }
        }))
        get().render()
        return
      }
      publish(path, {
        ...doc,
        past: [...doc.past, doc.gesture].slice(-100),
        future: [],
        gesture: undefined,
        revision: doc.revision + 1,
        dirty: true
      })
    },
    // History can change between the SFD RAW and the unfused RAW of an X3I.
    undo() {
      if (get().closing || get().loading) return
      get().commit()
      const path = get().session?.path
      if (!path || useQueueStore.getState().isProcessing) return
      const doc = get().documents[path]
      const recipe = doc.past.at(-1)
      if (recipe && !blocked(get(), recipe))
        publish(path, {
          ...doc,
          recipe,
          past: doc.past.slice(0, -1),
          future: [doc.recipe, ...doc.future],
          revision: doc.revision + 1,
          dirty: true
        })
    },
    redo() {
      if (get().closing || get().loading) return
      const path = get().session?.path
      if (!path || useQueueStore.getState().isProcessing) return
      const doc = get().documents[path]
      const recipe = doc.future[0]
      if (recipe && !blocked(get(), recipe))
        publish(path, {
          ...doc,
          recipe,
          past: [...doc.past, doc.recipe],
          future: doc.future.slice(1),
          revision: doc.revision + 1,
          dirty: true
        })
    },
    reset() {
      const path = get().session?.path
      // The frames of an X3I are not an adjustment.
      const recipe = path && get().documents[path].recipe
      if (recipe)
        get().change({
          ...asShotRecipe(get().session, recipe),
          x3iSource: recipe.x3iSource
        })
    },
    compare(before) {
      // Crop mode edits geometry; comparing would block its changes and its Cancel.
      if (get().closing || get().loading || get().cropping || unmerged(get())) return
      if (get().before === before) return
      set({ before, tile: null, cache: null })
      get().render()
    },
    copy(target) {
      if (get().closing || get().loading) return
      const path = get().session?.path
      const queue = useQueueStore.getState()
      const file = queue.files.find((item) => item.id === (target?.id ?? queue.activeId))
      const recipe = path && !target ? get().documents[path]?.recipe : file?.edit?.recipe
      const source = path && !target ? get().session : file
      if (recipe)
        set({
          clipboard: structuredClone(recipe),
          clipboardCapabilities: source ? capabilitiesOf(source) : undefined
        })
    },
    async paste(files) {
      // Crop mode's Cancel restores geometry only, so it could not undo a paste.
      // An X3I without its merge shows no result of a paste.
      if (get().closing || get().loading || get().cropping || unmerged(get())) return
      const source = get().clipboard
      if (!source || useQueueStore.getState().isProcessing) return
      const queue = useQueueStore.getState()
      const targets = files ?? queue.files.filter((file) => queue.selectedIds.has(file.id))
      const missing = targets.filter(
        (file) => !get().documents[file.path]?.sourceRevision && !file.edit?.sourceRevision
      )
      try {
        if (missing.length) {
          const loaded = await ipc.invoke('editor:load', {
            paths: missing.map((file) => file.path)
          })
          if (get().closing || get().loading || useQueueStore.getState().isProcessing) return
          for (const record of loaded) {
            if (record.error) throw new Error(record.error)
            const file = missing.find((file) => file.path === record.path)
            if (file)
              set((state) => ({
                documents: {
                  ...state.documents,
                  [file.path]: {
                    ...document(file),
                    ...record,
                    recipe: record.recipe ?? sourceDefaultRecipe(capabilitiesOf(file))
                  }
                }
              }))
          }
        }
      } catch (error) {
        set({ error: String(error) })
        return
      }
      // Crop mode may have opened while the photos loaded.
      if (get().closing || get().loading || get().cropping || useQueueStore.getState().isProcessing)
        return
      for (const file of targets.filter((item) => !item.pending)) {
        const doc = document(file)
        const recipe = pasteRecipe(
          source,
          doc.recipe,
          get().clipboardCapabilities,
          capabilitiesOf(file)
        )
        if (!same(doc.recipe, recipe))
          publish(file.path, {
            ...doc,
            recipe,
            past: [...doc.past, doc.recipe].slice(-100),
            future: [],
            revision: doc.revision + 1,
            dirty: true
          })
      }
      await get().flush()
    },
    async flush() {
      get().commit()
      await Promise.all([...saves])
      const dirty = Object.entries(get().documents).filter(([, doc]) => doc.dirty)
      for (const [path] of dirty) save(path)
      await Promise.all([...saves])
      return !Object.values(get().documents).some((doc) => doc.dirty)
    },
    async close() {
      if (get().closing || get().loading) return false
      set({ loading: true })
      if (!(await get().flush()) || get().closing) {
        set({ loading: false })
        return false
      }
      ++opening
      ++renderRevision
      renderPending = false
      navigationPending = false
      refinementPending = false
      clearTimeout(renderTimer)
      clearTimeout(refinementTimer)
      clearTimeout(prefetchTimer)
      set({ previewKey: null })
      const session = get().session
      try {
        if (session) await ipc.invoke('editor:close', { sessionId: session.sessionId })
        set({
          session: null,
          whiteBalanceExtended: false,
          x3i: null,
          switching: false,
          preview: null,
          renderedDemosaic: null,
          renderFailed: false,
          loading: false,
          rendering: false,
          before: false,
          cropping: false,
          viewport: null,
          tile: null,
          cache: null,
          error: null,
          mixNotice: null
        })
        useNavStore.getState().goToQueue()
        return true
      } catch (error) {
        set({ error: String(error), loading: false })
        return false
      }
    },
    render(navigation = false) {
      if (get().closing) return
      ++renderRevision
      renderPending = true
      navigationPending = navigation
      refinementPending = false
      clearTimeout(renderTimer)
      clearTimeout(refinementTimer)
      clearTimeout(prefetchTimer)
      const sessionId = get().session?.sessionId
      // A pan waits for refinement but not for prefetch; an edit cancels both.
      if (
        renderRunning &&
        (prefetchRunning || (!navigation && refining)) &&
        !cancellationSent &&
        sessionId
      ) {
        cancellationSent = true
        void ipc
          .invoke('editor:cancelRender', { sessionId, revision: runningRevision })
          .catch(() => {})
      }
      renderTimer = setTimeout(() => {
        void runRender()
      }, 0)
    },
    async pickWhiteBalance(x, y) {
      if (get().closing || get().loading || unmerged(get())) return
      const session = get().session
      if (
        !session ||
        !hasWhiteBalance(capabilitiesOf(session), get().documents[session.path].recipe)
      )
        return
      const request = ++colorPick
      try {
        const result = await ipc.invoke('editor:pickWhiteBalance', {
          sessionId: session.sessionId,
          x,
          y,
          recipe: get().documents[session.path].recipe,
          gains: get().whiteBalanceExtended
        })
        if (request !== colorPick || get().session?.sessionId !== session.sessionId) return
        const current = get().documents[session.path].recipe
        if ('rawColor' in result) {
          if (current.rawColor)
            get().change({ rawColor: { ...current.rawColor, gains: result.rawColor.gains } })
        } else if (!current.rawColor) {
          get().change(
            'whiteBalanceGains' in result ? result : { ...result, whiteBalanceGains: null }
          )
        }
      } catch (error) {
        if (request === colorPick && get().session?.sessionId === session.sessionId)
          set({ error: String(error) })
      }
    },
    async pickRawMix(x, y, output) {
      const state = get()
      const session = state.session
      if (
        !session ||
        state.before ||
        state.loading ||
        state.closing ||
        unmerged(state) ||
        useQueueStore.getState().isProcessing ||
        useQueueStore.getState().isPreparing
      )
        return
      get().commit()
      const recipe = get().documents[session.path]?.recipe
      if (!recipe?.rawColor) return
      set({ mixNotice: null })
      const request = ++colorPick
      const current = (): boolean =>
        request === colorPick &&
        get().session?.sessionId === session.sessionId &&
        get().documents[session.path]?.recipe === recipe &&
        !get().closing &&
        !get().loading &&
        !get().before &&
        !useQueueStore.getState().isProcessing &&
        !useQueueStore.getState().isPreparing
      try {
        const result = await ipc.invoke('editor:pickWhiteBalance', {
          sessionId: session.sessionId,
          recipe,
          x,
          y
        })
        if (!current() || !('rawColor' in result)) return
        // Neutral gains encode the sampled layer ratios without applying white balance.
        const sample = recipe.rawColor.gains.map((gain, i) => gain / result.rawColor.gains[i]) as [
          number,
          number,
          number
        ]
        const matrix = qualifyMix(recipe.rawColor.matrix, sample, output)
        if (!matrix) {
          set({ mixNotice: t('editor.mixQualifierCannotFit') })
          return
        }
        get().change({ rawColor: { ...recipe.rawColor, matrix } })
      } catch (error) {
        if (current()) {
          const message = error instanceof Error ? error.message : String(error)
          if (/neutral|channel gains/.test(message))
            set({ mixNotice: t('editor.mixQualifierCannotFit') })
          else set({ error: message })
        }
      }
    },
    async renderThumbnail(recipe) {
      const { session, closing, loading } = get()
      if (!session || closing || loading || unmerged(get()) || renderRunning || renderPending)
        return null
      // A new render request cancels the one in flight, so prefetch waits for this one.
      ++thumbnailsRunning
      try {
        const preview = await ipc.invoke('editor:render', {
          sessionId: session.sessionId,
          recipe,
          revision: renderRevision,
          interactive: true,
          maxEdge: 240
        })
        return preview.sessionId === get().session?.sessionId ? preview.url : null
      } finally {
        if (--thumbnailsRunning === 0) schedulePrefetch()
      }
    },
    processX3i() {
      const { session, x3i, loading } = get()
      // While another photo opens, the dialog still shows the previous one.
      if (!session || !x3i || loading || x3i.processed || x3i.progress !== undefined) return
      const path = session.path
      if (cancelledX3i === path) cancelledX3i = null
      merging.add(path)
      if (!usesSfd(get().documents[path].recipe)) mergeSwitch = path
      set({ x3i: { ...x3i, progress: 0, error: undefined } })
      void ipc
        .invoke('editor:x3iProcess', { path, recipe: get().documents[path].recipe })
        .then(
          () => undefined,
          (error: unknown) => String(error)
        )
        .then(async (error) => {
          merging.delete(path)
          await get().refreshX3i()
          if (mergeSwitch === path) mergeSwitch = null
          const current = get().x3i
          if (get().session?.path !== path || !current) return
          // The request has ended, so its merge has too, unless a new one started.
          // Progress that remains came from an earlier poll or a failed read.
          const progress = merging.has(path) ? current.progress : undefined
          // A failure before the merge starts has no status of its own.
          const failed =
            error !== undefined &&
            progress === undefined &&
            !current.processed &&
            !current.error &&
            cancelledX3i !== path
          set({ x3i: { ...current, progress, ...(failed && { error }) } })
        })
    },
    deleteX3i() {
      const { session, x3i } = get()
      if (!session || !x3i?.processed || x3i.progress !== undefined) return
      const path = session.path
      // The photo changes to its unfused RAW first, so it does not wait for a merge.
      if (usesSfd(get().documents[path].recipe)) get().change({ x3iSource: undefined })
      void ipc
        .invoke('editor:x3iDelete', { path, recipe: get().documents[path].recipe })
        .catch((error: unknown) => set({ error: String(error) }))
        .then(() => get().refreshX3i())
    },
    cancelX3i() {
      const path = get().session?.path
      if (!path) return
      cancelledX3i = path
      if (mergeSwitch === path) mergeSwitch = null
      void ipc
        .invoke('editor:x3iCancel', { path })
        .then(() => get().refreshX3i())
        .catch(() => {})
    },
    refreshX3i(poll = false) {
      if (poll && refreshBusy) return Promise.resolve()
      const read = async (): Promise<void> => {
        const { session } = get()
        if (!session?.x3i) return
        const path = session.path
        refreshBusy = true
        const status = await ipc
          .invoke('editor:x3iStatus', { path, recipe: get().documents[path].recipe })
          .catch(() => null)
          .finally(() => (refreshBusy = false))
        const current = get()
        if (!status || current.session?.path !== path) return
        const merged = unmerged(current) && status.processed
        const waiting = merging.has(path) && !status.processed && status.progress === undefined
        set({ x3i: waiting ? { ...status, progress: current.x3i?.progress ?? 0 } : status })
        if (merged) get().render()
        // Only the first read switches, so a later choice of the user stays.
        if (status.processed && mergeSwitch === path) {
          mergeSwitch = null
          if (!usesSfd(get().documents[path]?.recipe)) get().change({ x3iSource: 'merge' })
        }
      }
      const run = refreshing.then(read)
      refreshing = run.catch(() => {})
      return run
    }
  }
})

export function isTextEditing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input, textarea, select, [contenteditable="true"]')
  )
}
