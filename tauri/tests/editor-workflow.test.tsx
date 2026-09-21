// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { defaultRecipe, pasteRecipe, type EditRecipe } from '@shared/editor'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'
import { useEditorStore as editor, isTextEditing } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { useNavStore } from '../src/renderer/src/stores/navStore'
import { useIpcEvents } from '../src/renderer/src/hooks/useIpcEvents'
import { displayPreviewUrl } from '@shared/preview'

const file: X3FFileDTO = { id: 'a', path: '/photos/a.X3F', fileName: 'a.X3F' }
const invoke = vi.fn()
const events = new Map<string, (payload: never) => void>()
const session = () => ({
  sessionId: 'session-a',
  path: file.path,
  recipe: defaultRecipe(),
  revision: 0,
  storage: 'none',
  sourceRevision: 'source-a',
  width: 6000,
  height: 4000
})
const tick = async (): Promise<void> => {
  for (let i = 0; i < 12; ++i) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  events.clear()
  ;(window as unknown as { x3f: unknown }).x3f = {
    invoke,
    on: (name: string, callback: (payload: never) => void) => {
      events.set(name, callback)
      return () => events.delete(name)
    }
  }
  invoke
    .mockReset()
    .mockImplementation(async (command: string, payload: Record<string, unknown>) => {
      if (command === 'editor:open') return session()
      if (command === 'editor:save')
        return {
          ...payload,
          storage: 'sidecar',
          storagePath: `${payload.path}.x3fuse.json`,
          previewUrl: `x3f-preview://edit/${payload.revision}`
        }
      if (command === 'editor:render')
        return {
          sessionId: payload.sessionId,
          revision: payload.revision,
          url: `x3f-preview://render/${payload.revision}/${payload.maxEdge}`,
          width: payload.maxEdge,
          height: 1365,
          fullWidth: 6000,
          fullHeight: 4000,
          sourceWidth: 6000,
          sourceHeight: 4000,
          region: payload.region ? { ...(payload.region as object), x: 0.2001 } : undefined
        }
      if (command === 'editor:preview')
        return {
          url: `x3f-preview://snapshot/${payload.path}`,
          sourceRevision: `source:${payload.path}`
        }
      if (command === 'editor:load')
        return (payload.paths as string[]).map((path) => ({
          path,
          revision: 0,
          sourceRevision: `source:${path}`
        }))
      if (command === 'queue:existingOutputs') return []
    })
  editor.setState({
    session: null,
    documents: {},
    preview: null,
    loading: false,
    closing: false,
    rendering: false,
    error: null,
    before: false,
    clipboard: null,
    cropping: false,
    viewport: null,
    tile: null
  })
  queue.setState({
    files: [file],
    selectedIds: new Set(['a']),
    activeId: 'a',
    draft: null,
    batch: null,
    isPreparing: false,
    isProcessing: false,
    isCancelling: false,
    pendingReconversion: null,
    error: null
  })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
  useNavStore.setState({ screen: 'queue' })
})
afterEach(async () => {
  cleanup()
  invoke.mockResolvedValue(undefined)
  editor.setState({ documents: {}, closing: false })
  await editor.getState().close()
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('opens a real RAW session and saves one undo step for a slider gesture with the source fingerprint', async () => {
  await editor.getState().open(file)
  expect(useNavStore.getState().screen).toBe('editor')
  editor.getState().change({ exposure: 1 }, false)
  editor.getState().change({ exposure: 2 }, false)
  expect(invoke.mock.calls.filter(([command]) => command === 'editor:save')).toHaveLength(0)
  editor.getState().commit()
  await editor.getState().flush()
  expect(invoke).toHaveBeenCalledWith(
    'editor:save',
    expect.objectContaining({
      sourceRevision: 'source-a',
      revision: 1,
      recipe: expect.objectContaining({ exposure: 2 })
    })
  )
  expect(editor.getState().documents[file.path].past).toHaveLength(1)
  editor.getState().undo()
  expect(editor.getState().documents[file.path].recipe.exposure).toBe(0)
  editor.getState().redo()
  expect(editor.getState().documents[file.path].recipe.exposure).toBe(2)
  await editor.getState().flush()
  expect(queue.getState().files[0].edit?.recipe.exposure).toBe(2)
})

it('rejects stale renders and uses a smaller proxy during gestures plus original-pixel region rendering', async () => {
  let finish!: (value: unknown) => void
  const real = invoke.getMockImplementation()!
  let count = 0
  invoke.mockImplementation((command, payload) => {
    if (command === 'editor:render' && count++ === 0)
      return new Promise((resolve) => {
        finish = resolve
      })
    return real(command, payload)
  })
  await editor.getState().open(file)
  editor.getState().change({ exposure: 1 }, false)
  await vi.advanceTimersByTimeAsync(60)
  expect(invoke).toHaveBeenCalledWith('editor:render', expect.objectContaining({ maxEdge: 1024 }))
  editor.getState().change({ exposure: 2 }, false)
  await vi.advanceTimersByTimeAsync(60)
  finish({ sessionId: 'session-a', revision: -1, url: 'stale', width: 1024, height: 683 })
  await tick()
  expect(editor.getState().preview?.url).not.toBe('stale')
  editor.getState().commit()
  const region = { x: 0.2, y: 0.3, width: 0.3, height: 0.25 }
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(300)
  expect(invoke).toHaveBeenCalledWith(
    'editor:render',
    expect.objectContaining({ maxEdge: 4096, region })
  )
  expect(editor.getState().tile?.region).toEqual({ ...region, x: 0.2001 })
  expect(editor.getState().preview?.fullWidth).toBe(6000)
})

it('renders immediately at interactive resolution and refines only after input settles', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledWith(
    'editor:render',
    expect.objectContaining({ maxEdge: 1024, interactive: true })
  )
  await vi.advanceTimersByTimeAsync(99)
  expect(
    invoke.mock.calls.some(([command, p]) => command === 'editor:render' && p.maxEdge === 2048)
  ).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(invoke).toHaveBeenCalledWith(
    'editor:render',
    expect.objectContaining({ maxEdge: 2048, interactive: false })
  )
})

it('refines a draft native viewport without changing the saved denoise setting', async () => {
  const real = invoke.getMockImplementation()!
  invoke.mockImplementation(async (command, payload) => {
    const result = await real(command, payload)
    return command === 'editor:render' ? { ...result, draft: payload.interactive } : result
  })
  await editor.getState().open(file)
  const region = { x: 0.2, y: 0.3, width: 0.3, height: 0.25 }
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  expect(editor.getState().tile?.draft).toBe(true)
  await vi.advanceTimersByTimeAsync(100)
  expect(editor.getState().tile?.draft).toBe(false)
  const requests = invoke.mock.calls.filter(([command]) => command === 'editor:render')
  expect(requests.map(([, payload]) => [payload.maxEdge, payload.interactive])).toEqual([
    [4096, true],
    [4096, false]
  ])
  expect(requests.every(([, payload]) => payload.recipe.denoise === 10)).toBe(true)
  expect(editor.getState().documents[file.path].recipe.denoise).toBe(10)
})

it('interrupts expensive refinement when a new gesture needs a preview', async () => {
  const real = invoke.getMockImplementation()!
  let cancelDetail!: (error: Error) => void
  invoke.mockImplementation((command, payload) => {
    if (command === 'editor:render' && payload.maxEdge === 2048)
      return new Promise((_, reject) => {
        cancelDetail = reject
      })
    return real(command, payload)
  })
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(100)
  const detail = invoke.mock.calls.find(
    ([command, payload]) => command === 'editor:render' && payload.maxEdge === 2048
  )![1]
  editor.getState().change({ exposure: 1 }, false)
  expect(invoke).toHaveBeenCalledWith('editor:cancelRender', {
    sessionId: 'session-a',
    revision: detail.revision
  })
  cancelDetail(new Error('Rendering cancelled'))
  await tick()
  expect(editor.getState().error).toBeNull()
  expect(editor.getState().preview?.width).toBe(1024)
  expect(invoke).toHaveBeenLastCalledWith(
    'editor:render',
    expect.objectContaining({
      maxEdge: 1024,
      recipe: expect.objectContaining({ exposure: 1 })
    })
  )
})

it('paints intermediate frames within a drag but rejects old gesture frames during a new drag', async () => {
  const real = invoke.getMockImplementation()!
  const pending: Array<{ payload: Record<string, unknown>; finish: (value: unknown) => void }> = []
  invoke.mockImplementation((command, payload) => {
    if (command === 'editor:render' && pending.length < 2)
      return new Promise((finish) => {
        pending.push({ payload, finish })
      })
    return real(command, payload)
  })
  await editor.getState().open(file)
  editor.getState().change({ exposure: 1 }, false)
  await vi.advanceTimersByTimeAsync(0)
  editor.getState().change({ exposure: 2 }, false)
  pending[0].finish({ ...pending[0].payload, url: 'intermediate', width: 1024, height: 683 })
  await tick()
  expect(editor.getState().preview?.url).toBe('intermediate')
  editor.getState().commit()
  editor.getState().change({ exposure: 3 }, false)
  const painted: string[] = []
  const unsubscribe = editor.subscribe(({ preview }) => {
    if (preview) painted.push(preview.url)
  })
  pending[1].finish({ ...pending[1].payload, url: 'old-gesture', width: 1024, height: 683 })
  await tick()
  unsubscribe()
  expect(painted).not.toContain('old-gesture')
  expect(editor.getState().preview?.url).not.toBe('old-gesture')
})

it('resumes idle refinement after a gesture returns to its starting value without saving an undo step', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  editor.getState().change({ exposure: 1 }, false)
  await vi.advanceTimersByTimeAsync(0)
  editor.getState().change({ exposure: 0 }, false)
  await vi.advanceTimersByTimeAsync(0)
  invoke.mockClear()
  editor.getState().commit()
  const doc = editor.getState().documents[file.path]
  expect(doc.gesture).toBeUndefined()
  expect(doc.past).toHaveLength(0)
  expect(doc.revision).toBe(0)
  expect(doc.dirty).toBe(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledWith(
    'editor:render',
    expect.objectContaining({ maxEdge: 1024, recipe: expect.objectContaining({ exposure: 0 }) })
  )
  await vi.advanceTimersByTimeAsync(99)
  expect(
    invoke.mock.calls.some(
      ([command, payload]) => command === 'editor:render' && payload.maxEdge === 2048
    )
  ).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(invoke).toHaveBeenCalledWith('editor:render', expect.objectContaining({ maxEdge: 2048 }))
  expect(invoke.mock.calls.some(([command]) => command === 'editor:save')).toBe(false)
})

it('coalesces sensor denoise preparation until the slider gesture is committed', async () => {
  await editor.getState().open(file)
  editor.getState().change({ denoise: 3 }, false)
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith(
    'editor:render',
    expect.objectContaining({
      recipe: expect.objectContaining({ denoise: 10 })
    })
  )
  editor.getState().change({ denoise: 5 }, false)
  editor.getState().commit()
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith(
    'editor:render',
    expect.objectContaining({
      recipe: expect.objectContaining({ denoise: 5 })
    })
  )
})

it('copies development adjustments while retaining each destination crop, rotation and grain seed', async () => {
  const source: EditRecipe = {
    ...defaultRecipe(),
    exposure: 2,
    crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    rotation: 1,
    straighten: 12,
    seed: 42
  }
  const target = { ...defaultRecipe(), rotation: 2, seed: 7 }
  expect(pasteRecipe(source, target)).toMatchObject({
    exposure: 2,
    crop: null,
    rotation: 2,
    straighten: 0,
    seed: 7
  })
  editor.setState({ clipboard: source })
  await editor.getState().paste([file])
  expect(invoke).toHaveBeenCalledWith('editor:load', { paths: [file.path] })
  expect(invoke).toHaveBeenCalledWith(
    'editor:save',
    expect.objectContaining({
      sourceRevision: `source:${file.path}`,
      recipe: expect.objectContaining({ exposure: 2, crop: null, seed: 0 })
    })
  )
})

it('does not let a completed autosave overwrite a newer slider gesture', async () => {
  await editor.getState().open(file)
  const real = invoke.getMockImplementation()!
  let finish!: (value: unknown) => void
  invoke.mockImplementation((command, payload) =>
    command === 'editor:save' && payload.revision === 1
      ? new Promise((resolve) => {
          finish = resolve
        })
      : real(command, payload)
  )
  editor.getState().change({ exposure: 1 })
  editor.getState().change({ exposure: 2 }, false)
  finish({
    recipe: { ...defaultRecipe(), exposure: 1 },
    revision: 1,
    sourceRevision: 'source-a',
    storage: 'sidecar'
  })
  await tick()
  expect(editor.getState().documents[file.path].recipe.exposure).toBe(2)
  expect(queue.getState().files[0].edit?.recipe.exposure).toBe(1)
  editor.getState().commit()
  await editor.getState().flush()
  expect(queue.getState().files[0].edit?.recipe.exposure).toBe(2)
})

it('keeps failed saves open and handles native close only after flushing the current gesture', async () => {
  await editor.getState().open(file)
  renderHook(() => useIpcEvents())
  editor.getState().change({ contrast: 30 }, false)
  const real = invoke.getMockImplementation()!
  invoke.mockImplementation((command, payload) =>
    command === 'editor:save' ? Promise.reject(new Error('Disk full')) : real(command, payload)
  )
  await act(async () => {
    events.get('editor:closing')?.({ quit: true } as never)
    await tick()
  })
  expect(editor.getState().error).toContain('Disk full')
  expect(editor.getState().closing).toBe(false)
  expect(invoke.mock.calls.some(([command]) => command === 'editor:finishClose')).toBe(false)
  expect(await editor.getState().close()).toBe(false)
  invoke.mockImplementation(real)
  await act(async () => {
    events.get('editor:closing')?.({ quit: true } as never)
    await tick()
  })
  expect(invoke).toHaveBeenCalledWith('editor:finishClose', { quit: true })
})

it('freezes mutations and navigation while native close flushes the last accepted gesture', async () => {
  await editor.getState().open(file)
  renderHook(() => useIpcEvents())
  editor.getState().change({ exposure: 1 }, false)
  const real = invoke.getMockImplementation()!
  let finish!: (value: unknown) => void
  invoke.mockImplementation((command, payload) =>
    command === 'editor:save'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : real(command, payload)
  )
  act(() => events.get('editor:closing')?.({ quit: false } as never))
  expect(editor.getState().closing).toBe(true)
  editor.getState().change({ exposure: 3 })
  editor.getState().undo()
  queue.getState().deselectAll()
  queue.getState().openExport()
  await editor.getState().open({ ...file, id: 'b', path: '/photos/b.X3F' })
  expect(editor.getState().documents[file.path].recipe.exposure).toBe(1)
  expect(queue.getState().selectedIds.has(file.id)).toBe(true)
  expect(queue.getState().draft).toBeNull()
  expect(editor.getState().session?.path).toBe(file.path)
  finish({
    recipe: { ...defaultRecipe(), exposure: 1 },
    revision: 1,
    sourceRevision: 'source-a',
    storage: 'sidecar'
  })
  await act(tick)
  expect(invoke).toHaveBeenCalledWith('editor:finishClose', { quit: false })
})

it('blocks new changes while normal editor close waits for its accepted gesture to save', async () => {
  await editor.getState().open(file)
  editor.getState().change({ exposure: 1 }, false)
  const real = invoke.getMockImplementation()!
  let finish!: (value: unknown) => void
  invoke.mockImplementation((command, payload) =>
    command === 'editor:save' && payload.revision === 1
      ? new Promise((resolve) => {
          finish = resolve
        })
      : real(command, payload)
  )
  const closing = editor.getState().close()
  const loading = editor.getState().loading
  editor.getState().change({ exposure: 3 })
  editor.getState().undo()
  editor.getState().compare(true)
  const duringClose = {
    exposure: editor.getState().documents[file.path].recipe.exposure,
    before: editor.getState().before
  }
  finish({
    recipe: { ...defaultRecipe(), exposure: 1 },
    revision: 1,
    sourceRevision: 'source-a',
    storage: 'sidecar'
  })
  expect(await closing).toBe(true)
  expect(loading).toBe(true)
  expect(duringClose).toEqual({ exposure: 1, before: false })
  expect(invoke.mock.calls.filter(([command]) => command === 'editor:save')).toHaveLength(1)
  expect(editor.getState().session).toBeNull()
  expect(editor.getState().loading).toBe(false)
})

it('discards paste metadata that arrives while normal editor close is pending', async () => {
  await editor.getState().open(file)
  const other = { id: 'b', path: '/photos/b.X3F', fileName: 'b.X3F' }
  editor.setState({ clipboard: { ...defaultRecipe(), exposure: 2 } })
  const real = invoke.getMockImplementation()!
  let finishLoad!: (value: unknown) => void
  let finishClose!: (value: unknown) => void
  invoke.mockImplementation((command, payload) => {
    if (command === 'editor:load')
      return new Promise((resolve) => {
        finishLoad = resolve
      })
    if (command === 'editor:close')
      return new Promise((resolve) => {
        finishClose = resolve
      })
    return real(command, payload)
  })
  const pasting = editor.getState().paste([other])
  const closing = editor.getState().close()
  await tick()
  const loading = editor.getState().loading
  finishLoad([{ path: other.path, revision: 0, sourceRevision: 'source-b' }])
  await pasting
  const pasted = editor.getState().documents[other.path]
  finishClose(undefined)
  expect(await closing).toBe(true)
  expect(loading).toBe(true)
  expect(pasted).toBeUndefined()
  expect(
    invoke.mock.calls.some(
      ([command, payload]) => command === 'editor:save' && payload.path === other.path
    )
  ).toBe(false)
})

it('persists untouched camera framing and grain seed when returning to the queue without adding undo history', async () => {
  const crop = { x: 0, y: 0.125, width: 1, height: 0.75 }
  const recipe = { ...defaultRecipe(), crop, seed: 123456 }
  const real = invoke.getMockImplementation()!
  invoke.mockImplementation((command, payload) =>
    command === 'editor:open'
      ? Promise.resolve({ ...session(), recipe, asShotCrop: crop })
      : real(command, payload)
  )
  await editor.getState().open(file)
  expect(await editor.getState().close()).toBe(true)
  expect(invoke).toHaveBeenCalledWith('editor:save', {
    path: file.path,
    recipe,
    revision: 1,
    sourceRevision: 'source-a'
  })
  expect(queue.getState().files[0].edit).toMatchObject({ recipe, revision: 1 })
  expect(editor.getState().documents[file.path].past).toHaveLength(0)
  expect(useNavStore.getState().screen).toBe('queue')
})

it('exports untouched camera framing and grain seed from the active session', async () => {
  const crop = { x: 0, y: 0.125, width: 1, height: 0.75 }
  const recipe = { ...defaultRecipe(), crop, seed: 123456 }
  const real = invoke.getMockImplementation()!
  invoke.mockImplementation((command, payload) => {
    if (command === 'editor:open')
      return Promise.resolve({ ...session(), recipe, asShotCrop: crop })
    if (command === 'editor:preview')
      return Promise.resolve({ url: 'as-shot-preview', sourceRevision: payload.sourceRevision })
    return real(command, payload)
  })
  await editor.getState().open(file)
  expect(queue.getState().files[0].edit).toBeUndefined()
  queue.getState().openExport(undefined, 'editor')
  await tick()
  expect(queue.getState().draft?.files[0]).toMatchObject({
    sourceRevision: 'source-a',
    edit: { recipe, revision: 1, sourceRevision: 'source-a' }
  })
  expect(invoke).toHaveBeenCalledWith('editor:preview', {
    path: file.path,
    recipe,
    revision: 1,
    sourceRevision: 'source-a'
  })
  await queue.getState().commitExport()
  expect(invoke).toHaveBeenCalledWith(
    'convert:start',
    expect.objectContaining({
      files: [
        expect.objectContaining({
          path: file.path,
          recipe,
          revision: 1,
          sourceRevision: 'source-a'
        })
      ]
    })
  )
  expect(invoke).toHaveBeenCalledWith('editor:save', {
    path: file.path,
    recipe,
    revision: 1,
    sourceRevision: 'source-a'
  })
  expect(editor.getState().documents[file.path].past).toHaveLength(0)
})

it('freezes rendered recipes and fingerprints for mixed batches and returns shared review to the editor', async () => {
  const edited = {
    ...file,
    edit: { recipe: { ...defaultRecipe(), exposure: 2 }, revision: 3, sourceRevision: 'source-a' }
  }
  const other = { id: 'b', path: '/photos/b.X3F', fileName: 'b.X3F' }
  queue.setState({ files: [edited, other], selectedIds: new Set(['a', 'b']) })
  queue.getState().openExport(undefined, 'editor')
  expect(queue.getState().isPreparing).toBe(true)
  await tick()
  const draft = queue.getState().draft!
  expect(draft.settings).toMatchObject({
    rendering: 'rendered',
    outputFormat: 'jpeg',
    cineon: false
  })
  expect(draft.files.every((file) => file.sourceRevision && file.displayPreviewUrl)).toBe(true)
  queue.getState().updateDraft({ outputFormat: 'tiff' })
  queue.getState().updateDraft({ outputFormat: 'jpeg' })
  expect(queue.getState().draft?.settings.outputFormat).toBe('jpeg')
  edited.edit.recipe.exposure = 5
  expect(draft.files[0].edit?.recipe.exposure).toBe(2)
  await queue.getState().commitExport()
  const request = invoke.mock.calls.find(([command]) => command === 'convert:start')![1]
  expect(request.files[0]).toMatchObject({
    recipe: { exposure: 2 },
    sourceRevision: `source:${file.path}`
  })
  expect(request.files[1]).toMatchObject({ recipe: { exposure: 0 } })
  queue.getState().onBatchStarted({ batchId: request.batchId, settings: request.settings })
  expect(useNavStore.getState().screen).toBe('editor')
})

it('never substitutes embedded JPEG for an edited preview and leaves text editing shortcuts alone', () => {
  expect(displayPreviewUrl({ ...file, edit: { recipe: defaultRecipe(), revision: 1 } })).toBe('')
  expect(
    displayPreviewUrl({
      ...file,
      edit: { recipe: defaultRecipe(), revision: 1, previewUrl: 'edited' }
    })
  ).toBe('edited')
  expect(isTextEditing(document.createElement('input'))).toBe(true)
  expect(isTextEditing(document.createElement('button'))).toBe(false)
})

it('requests small edited thumbnails while preserving full viewer and live editor URLs', () => {
  for (const host of ['x3f-edit://localhost', 'http://x3f-edit.localhost']) {
    const url = `${host}/${'a'.repeat(64)}`
    const edited = { ...file, edit: { recipe: defaultRecipe(), revision: 1, previewUrl: url } }
    expect(displayPreviewUrl(edited)).toBe(`${url}?v=thumbnail`)
    expect(displayPreviewUrl(edited, 'full')).toBe(url)
    expect(displayPreviewUrl({ ...file, displayPreviewUrl: url })).toBe(url)
    expect(displayPreviewUrl({ ...file, displayPreviewUrl: url }, 'full')).toBe(url)
  }
})

it('renders only the visible region while zoomed and preserves the whole-image base through adjustments', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  const base = editor.getState().preview
  const region = { x: 0.2, y: 0.3, width: 0.25, height: 0.2 }
  invoke.mockClear()
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  const firstTile = editor.getState().tile
  expect(firstTile?.viewport).toEqual(region)
  expect(editor.getState().preview).toBe(base)
  expect(invoke).toHaveBeenCalledWith(
    'editor:render',
    expect.objectContaining({ region, maxEdge: 4096 })
  )
  editor.getState().change({ exposure: 1 }, false)
  expect(editor.getState().tile).toBe(firstTile)
  await vi.advanceTimersByTimeAsync(0)
  expect(editor.getState().tile?.url).not.toBe(firstTile?.url)
  expect(invoke).toHaveBeenLastCalledWith(
    'editor:render',
    expect.objectContaining({ region, maxEdge: 1024 })
  )
  editor.getState().commit()
  await vi.advanceTimersByTimeAsync(100)
  const requests = invoke.mock.calls
    .filter(([command]) => command === 'editor:render')
    .map(([, request]) => request)
  expect(requests.length).toBeGreaterThan(2)
  expect(
    requests.every((request) => JSON.stringify(request.region) === JSON.stringify(region))
  ).toBe(true)
  expect(requests.at(-1)?.maxEdge).toBe(4096)
  expect(editor.getState().preview).toBe(base)
  expect(editor.getState().tile?.width).toBe(4096)
  editor.getState().setViewport(null)
  expect(editor.getState().tile).toBeNull()
  await vi.advanceTimersByTimeAsync(0)
  const fit = invoke.mock.calls.filter(([command]) => command === 'editor:render').at(-1)![1]
  expect(fit.region).toBeUndefined()
  expect(fit.maxEdge).toBe(1024)
  expect(editor.getState().preview?.url).not.toBe(base?.url)
})

it('retains the last tile while rejecting an obsolete viewport during an edit gesture', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  const region = { x: 0.2, y: 0.3, width: 0.25, height: 0.2 }
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  const previousTile = editor.getState().tile
  const real = invoke.getMockImplementation()!
  let finish!: (value: unknown) => void
  let pending!: Record<string, unknown>
  invoke.mockImplementation((command, payload) => {
    if (command === 'editor:render' && !pending) {
      pending = payload
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    return real(command, payload)
  })
  editor.getState().change({ exposure: 1 }, false)
  await vi.advanceTimersByTimeAsync(0)
  const next = { ...region, x: 0.5 }
  editor.getState().setViewport(next)
  expect(editor.getState().tile).toBe(previousTile)
  finish({ ...pending, url: 'stale-viewport', width: 1024, height: 683 })
  await tick()
  expect(editor.getState().tile?.url).not.toBe('stale-viewport')
  expect(editor.getState().tile?.viewport).toEqual(next)
  expect(editor.getState().rendering).toBe(false)
})

it('renders a pan at native resolution without an intermediate proxy or redundant idle refinement', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  const region = { x: 0.2, y: 0.3, width: 0.25, height: 0.2 }
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  const previousTile = editor.getState().tile
  const base = editor.getState().preview
  const next = { ...region, x: 0.4 }
  invoke.mockClear()
  editor.getState().setViewport(next)
  expect(editor.getState().tile).toBe(previousTile)
  await vi.advanceTimersByTimeAsync(500)
  const requests = invoke.mock.calls.filter(([command]) => command === 'editor:render')
  expect(requests).toHaveLength(1)
  expect(requests[0][1]).toMatchObject({ region: next, maxEdge: 4096 })
  expect(editor.getState().tile?.viewport).toEqual(next)
  expect(editor.getState().preview).toBe(base)
  expect(editor.getState().rendering).toBe(false)
})

it('coalesces rapid pans without cancellation and rejects a completed obsolete viewport', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  const region = { x: 0.2, y: 0.3, width: 0.25, height: 0.2 }
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  const previousTile = editor.getState().tile
  const real = invoke.getMockImplementation()!
  const pending: Array<{ payload: Record<string, unknown>; finish: (value: unknown) => void }> = []
  invoke.mockClear().mockImplementation((command, payload) => {
    if (command === 'editor:render')
      return new Promise((finish) => pending.push({ payload, finish }))
    return real(command, payload)
  })
  const middle = { ...region, x: 0.3 }
  const next = { ...region, x: 0.5 }
  editor.getState().setViewport(middle)
  await vi.advanceTimersByTimeAsync(0)
  editor.getState().setViewport(next)
  await vi.advanceTimersByTimeAsync(0)
  const whilePending = editor.getState().tile
  pending[0].finish({ ...pending[0].payload, url: 'obsolete-pan', width: 4096, height: 3000 })
  await tick()
  const afterObsolete = editor.getState().tile
  pending[1].finish({ ...pending[1].payload, url: 'latest-pan', width: 4096, height: 3000 })
  await tick()
  await vi.advanceTimersByTimeAsync(500)
  expect(whilePending).toBe(previousTile)
  expect(afterObsolete).toBe(previousTile)
  expect(pending).toHaveLength(2)
  expect(pending.map(({ payload }) => payload.maxEdge)).toEqual([4096, 4096])
  expect(pending[1].payload.region).toEqual(next)
  expect(invoke.mock.calls.some(([command]) => command === 'editor:cancelRender')).toBe(false)
  expect(editor.getState().tile).toMatchObject({ url: 'latest-pan', viewport: next })
  expect(editor.getState().rendering).toBe(false)
})

it('interrupts a pending native pan for an adjustment and rejects its old recipe', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  const region = { x: 0.2, y: 0.3, width: 0.25, height: 0.2 }
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  const real = invoke.getMockImplementation()!
  let finish!: (value: unknown) => void
  let pending!: Record<string, unknown>
  invoke.mockClear().mockImplementation((command, payload) => {
    if (command === 'editor:render' && !pending) {
      pending = payload
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    return real(command, payload)
  })
  const painted: Array<string | undefined> = []
  const unsubscribe = editor.subscribe((state) => painted.push(state.tile?.url))
  const next = { ...region, x: 0.4 }
  editor.getState().setViewport(next)
  await vi.advanceTimersByTimeAsync(0)
  editor.getState().change({ exposure: 1 }, false)
  finish({ ...pending, url: 'pre-adjustment-pan', width: 4096, height: 3000 })
  await tick()
  unsubscribe()
  expect(invoke).toHaveBeenCalledWith('editor:cancelRender', {
    sessionId: 'session-a',
    revision: pending.revision
  })
  expect(painted).not.toContain('pre-adjustment-pan')
  expect(invoke).toHaveBeenLastCalledWith(
    'editor:render',
    expect.objectContaining({
      region: next,
      maxEdge: 1024,
      recipe: expect.objectContaining({ exposure: 1 })
    })
  )
  expect(editor.getState().tile?.viewport).toEqual(next)
  expect(editor.getState().error).toBeNull()
  expect(editor.getState().rendering).toBe(false)
})

it('finishes native viewport navigation while an edit gesture remains active', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  const region = { x: 0.2, y: 0.3, width: 0.25, height: 0.2 }
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  editor.getState().change({ exposure: 1 }, false)
  await vi.advanceTimersByTimeAsync(0)
  expect(editor.getState().documents[file.path].gesture).not.toBeNull()
  invoke.mockClear()
  const next = { ...region, x: 0.4 }
  editor.getState().setViewport(next)
  await vi.advanceTimersByTimeAsync(500)
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith(
    'editor:render',
    expect.objectContaining({ region: next, maxEdge: 4096 })
  )
  expect(editor.getState().tile?.viewport).toEqual(next)
  expect(editor.getState().rendering).toBe(false)
  expect(editor.getState().documents[file.path].gesture).not.toBeNull()
})

it('drops tile overlays for before/after and geometry changes, including undo', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  const region = { x: 0.2, y: 0.2, width: 0.25, height: 0.25 }
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  editor.getState().compare(true)
  expect(editor.getState().tile).toBeNull()
  expect(editor.getState().viewport).toEqual(region)
  await vi.advanceTimersByTimeAsync(0)
  expect(editor.getState().tile).not.toBeNull()
  editor.getState().compare(false)
  expect(editor.getState().tile).toBeNull()
  await vi.advanceTimersByTimeAsync(0)
  editor.getState().change({ rotation: 1 })
  expect(editor.getState().tile).toBeNull()
  expect(editor.getState().viewport).toBeNull()
  await vi.advanceTimersByTimeAsync(0)
  expect(
    invoke.mock.calls.filter(([command]) => command === 'editor:render').at(-1)?.[1].region
  ).toBeUndefined()
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  editor.getState().undo()
  expect(editor.getState().tile).toBeNull()
  expect(editor.getState().viewport).toBeNull()
})
