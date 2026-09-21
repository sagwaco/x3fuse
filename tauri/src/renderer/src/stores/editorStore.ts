import { create } from 'zustand'
import {
  defaultRecipe,
  pasteRecipe,
  type EditRecipe,
  type EditRecord,
  type EditorSession,
  type RenderedPreview,
  type PreviewRegion
} from '@shared/editor'
import type { X3FFileDTO } from '@shared/types'
import { ipc } from '../lib/ipc'
import { useQueueStore } from './queueStore'
import { useNavStore } from './navStore'

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
  error: string | null
  preview: RenderedPreview | null
  before: boolean
  cropping: boolean
  viewport: PreviewRegion | null
  tile: (RenderedPreview & { region: PreviewRegion; viewport: PreviewRegion }) | null
  setViewport: (region: PreviewRegion | null) => void
  setCropping: (cropping: boolean) => void
  clipboard: EditRecipe | null
  open: (file: X3FFileDTO) => Promise<void>
  change: (patch: Partial<EditRecipe>, commit?: boolean) => void
  commit: () => void
  undo: () => void
  redo: () => void
  reset: () => void
  compare: (before: boolean) => void
  copy: () => void
  paste: (files?: X3FFileDTO[]) => Promise<void>
  flush: () => Promise<boolean>
  close: () => Promise<boolean>
  render: (navigation?: boolean) => void
  pickWhiteBalance: (x: number, y: number) => Promise<void>
}

const same = (a: EditRecipe, b: EditRecipe): boolean => JSON.stringify(a) === JSON.stringify(b)
const sameGeometry = (a: EditRecipe, b: EditRecipe): boolean =>
  JSON.stringify([a.crop, a.rotation, a.straighten]) ===
  JSON.stringify([b.crop, b.rotation, b.straighten])
const sameRegion = (a: PreviewRegion | null, b: PreviewRegion | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b)
const saves = new Set<Promise<void>>()
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
const INTERACTIVE_EDGE = 1024
const REFINE_DELAY = 100

function updateQueue(path: string, edit: EditRecord): void {
  useQueueStore.setState((state) => ({
    files: state.files.map((file) =>
      file.path === path ? { ...file, edit, editError: undefined } : file
    )
  }))
}

export const useEditorStore = create<EditorState>((set, get) => {
  function document(file: X3FFileDTO): Document {
    return (
      get().documents[file.path] ?? {
        recipe: structuredClone(file.edit?.recipe ?? defaultRecipe()),
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
              storage: saved.storage,
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
    set((state) => {
      const geometryChanged =
        state.session?.path === path && !sameGeometry(state.documents[path].recipe, doc.recipe)
      return {
        documents: { ...state.documents, [path]: doc },
        error: null,
        before: false,
        ...(geometryChanged ? { viewport: null, tile: null } : state.before ? { tile: null } : {})
      }
    })
    save(path)
    get().render()
  }
  async function runRender(): Promise<void> {
    if (get().closing || renderRunning || (!renderPending && !refinementPending)) return
    const state = get()
    if (!state.session || state.loading || useQueueStore.getState().isProcessing) return
    const doc = state.documents[state.session.path]
    if (!doc) return
    const detail = !renderPending
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
    let recipe = state.before
      ? {
          ...defaultRecipe(),
          crop: doc.recipe.crop,
          rotation: doc.recipe.rotation,
          straighten: doc.recipe.straighten,
          seed: doc.recipe.seed
        }
      : doc.recipe
    if (state.cropping) recipe = { ...recipe, crop: null, rotation: 0, straighten: 0 }
    // Sensor NLM requires fresh RAW preparation. Coalesce slider moves and do it
    // once on commit; other controls keep using the already prepared source.
    if (doc.gesture && doc.gesture.denoise !== recipe.denoise)
      recipe = { ...recipe, denoise: doc.gesture.denoise }
    const region = !state.cropping ? state.viewport : null
    set({ rendering: true })
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
        if (region)
          set({ tile: { ...preview, region: preview.region ?? region, viewport: region } })
        else set({ preview })
        set({ error: Object.values(get().documents).find((doc) => doc.error)?.error ?? null })
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
      if (
        get().session?.sessionId === sessionId &&
        renderRevision === revision &&
        !get().closing &&
        !get().loading
      )
        set({ error: String(error) })
    } finally {
      renderRunning = false
      refining = false
      if (!renderPending && !refinementPending) set({ rendering: false })
      else void runRender()
    }
  }
  return {
    session: null,
    documents: {},
    loading: false,
    closing: false,
    rendering: false,
    error: null,
    preview: null,
    before: false,
    clipboard: null,
    cropping: false,
    viewport: null,
    tile: null,
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
    setCropping(cropping) {
      if (get().closing || get().loading) return
      get().commit()
      set({ cropping, viewport: null, tile: null, preview: null })
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
      set({ loading: true, error: null })
      useNavStore.getState().goToEditor()
      const previous = get().session
      try {
        if (previous) await ipc.invoke('editor:close', { sessionId: previous.sessionId })
        const session = await ipc.invoke('editor:open', { path: file.path })
        if (token !== opening || get().closing) {
          await ipc.invoke('editor:close', { sessionId: session.sessionId })
          return
        }
        const previousDocument = get().documents[file.path]
        const existing =
          previousDocument?.sourceRevision === session.sourceRevision &&
          previousDocument?.revision === session.revision
            ? previousDocument
            : undefined
        const doc = existing ?? {
          ...session,
          recipe: structuredClone(session.recipe),
          past: [],
          future: [],
          dirty: false
        }
        set((state) => ({
          session,
          documents: { ...state.documents, [file.path]: doc },
          loading: false,
          preview: null,
          before: false,
          cropping: false,
          viewport: null,
          tile: null
        }))
        get().render()
      } catch (error) {
        if (token === opening)
          set({ loading: false, session: null, preview: null, error: String(error) })
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
      const recipe = { ...doc.recipe, ...patch }
      if (same(recipe, doc.recipe)) return
      set((state) => ({
        before: false,
        ...(!sameGeometry(doc.recipe, recipe) ? { viewport: null, tile: null } : {}),
        documents: {
          ...state.documents,
          [path]: { ...doc, recipe, gesture: doc.gesture ?? doc.recipe }
        }
      }))
      if (commit) get().commit()
      else get().render()
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
    undo() {
      if (get().closing || get().loading) return
      get().commit()
      const path = get().session?.path
      if (!path || useQueueStore.getState().isProcessing) return
      const doc = get().documents[path]
      const recipe = doc.past.at(-1)
      if (recipe)
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
      if (recipe)
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
      get().change({
        ...defaultRecipe(),
        crop: get().session?.asShotCrop ?? null,
        seed: path ? get().documents[path].recipe.seed : 0
      })
    },
    compare(before) {
      if (get().closing || get().loading) return
      if (get().before === before) return
      set({ before, tile: null })
      get().render()
    },
    copy() {
      if (get().closing || get().loading) return
      const path = get().session?.path
      const queue = useQueueStore.getState()
      const file = queue.files.find((item) => item.id === queue.activeId)
      const recipe = path ? get().documents[path]?.recipe : file?.edit?.recipe
      if (recipe) set({ clipboard: structuredClone(recipe) })
    },
    async paste(files) {
      if (get().closing || get().loading) return
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
                    recipe: record.recipe ?? defaultRecipe()
                  }
                }
              }))
          }
        }
      } catch (error) {
        set({ error: String(error) })
        return
      }
      if (get().closing || get().loading || useQueueStore.getState().isProcessing) return
      for (const file of targets.filter((item) => !item.pending)) {
        const doc = document(file)
        const recipe = pasteRecipe(source, doc.recipe)
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
      const path = get().session?.path
      const doc = path && get().documents[path]
      // Opening the editor applies film and camera framing even without a gesture.
      // Persist that recipe so Done and a later queue export reproduce the preview.
      if (path && doc && doc.storage === 'none' && !doc.dirty)
        set((state) => ({
          documents: {
            ...state.documents,
            [path]: { ...doc, revision: doc.revision + 1, dirty: true }
          }
        }))
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
      const session = get().session
      try {
        if (session) await ipc.invoke('editor:close', { sessionId: session.sessionId })
        set({
          session: null,
          preview: null,
          loading: false,
          rendering: false,
          before: false,
          cropping: false,
          viewport: null,
          tile: null,
          error: null
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
      const sessionId = get().session?.sessionId
      if (!navigation && renderRunning && refining && !cancellationSent && sessionId) {
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
      if (get().closing || get().loading) return
      const session = get().session
      if (!session) return
      try {
        const result = await ipc.invoke('editor:pickWhiteBalance', {
          sessionId: session.sessionId,
          x,
          y,
          recipe: get().documents[session.path].recipe
        })
        if (get().session?.sessionId === session.sessionId) get().change(result)
      } catch (error) {
        set({ error: String(error) })
      }
    }
  }
})

export function isTextEditing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input, textarea, select, [contenteditable="true"]')
  )
}
