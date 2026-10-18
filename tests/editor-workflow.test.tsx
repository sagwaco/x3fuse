// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  DEFAULT_WHEELS,
  defaultRecipe,
  pasteRecipe,
  type EditRecipe,
  type X3iStatus
} from '@shared/editor'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'
import {
  useEditorStore as editor,
  isTextEditing,
  needsX3iMerge,
  previewCurrent
} from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { useNavStore } from '../src/renderer/src/stores/navStore'
import { useIpcEvents } from '../src/renderer/src/hooks/useIpcEvents'
import { displayPreviewUrl } from '@shared/preview'
import { nextPrefetch } from '../src/renderer/src/lib/previewTiles'

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

it('renders no frame for a wheel hue kept at zero strength', async () => {
  await editor.getState().open(file)
  await vi.waitFor(() => expect(editor.getState().rendering).toBe(false))
  const renders = (): number =>
    invoke.mock.calls.filter(([command]) => command === 'editor:render').length
  const before = renders()
  const midtones = { x: 0, y: 0, luminance: 0, hue: 1.5 }
  editor.getState().change({ wheels: { ...DEFAULT_WHEELS, midtones } }, false)
  expect(editor.getState().documents[file.path].recipe.wheels?.midtones.hue).toBe(1.5)
  // Renders start after a short wait. None starts here.
  await vi.advanceTimersByTimeAsync(250)
  expect(renders()).toBe(before)
  // The frame on screen is still the frame of the recipe.
  expect(previewCurrent(editor.getState())).toBe(true)
  editor
    .getState()
    .change({ wheels: { ...DEFAULT_WHEELS, midtones: { ...midtones, x: 0.5 } } }, false)
  await vi.waitFor(() => expect(renders()).toBeGreaterThan(before))
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

it('renders input at interactive resolution and refines only after input settles', async () => {
  const renders = (): Array<Record<string, unknown>> =>
    invoke.mock.calls.filter(([command]) => command === 'editor:render').map(([, p]) => p)
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  // Nothing shows yet, so a fast frame would show only until its refinement.
  expect(renders()).toEqual([expect.objectContaining({ maxEdge: 2048, interactive: false })])
  await vi.advanceTimersByTimeAsync(1000)
  expect(renders()).toHaveLength(1)
  editor.getState().change({ exposure: 1 })
  await vi.advanceTimersByTimeAsync(0)
  expect(renders().at(-1)).toMatchObject({ maxEdge: 1024, interactive: true })
  await vi.advanceTimersByTimeAsync(99)
  expect(renders()).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(renders().at(-1)).toMatchObject({ maxEdge: 2048, interactive: false })
})

it('refines a draft native viewport without changing the saved denoise setting', async () => {
  const real = invoke.getMockImplementation()!
  invoke.mockImplementation(async (command, payload) => {
    const result = await real(command, payload)
    return command === 'editor:render' ? { ...result, draft: payload.interactive } : result
  })
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(0)
  const region = { x: 0.2, y: 0.3, width: 0.3, height: 0.25 }
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  expect(editor.getState().tile?.draft).toBe(true)
  await vi.advanceTimersByTimeAsync(100)
  expect(editor.getState().tile?.draft).toBe(false)
  const requests = invoke.mock.calls.filter(
    ([command, payload]) => command === 'editor:render' && payload.region
  )
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

it('coalesces advanced denoise changes and refines using the complete recipe', async () => {
  await editor.getState().open(file)
  const denoiseOptions = { ...defaultRecipe().denoiseOptions, strength: 2, luminance: true }
  editor.getState().change({ denoiseOptions }, false)
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith(
    'editor:render',
    expect.objectContaining({
      recipe: expect.objectContaining({ denoiseOptions: defaultRecipe().denoiseOptions })
    })
  )
  editor.getState().commit()
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith(
    'editor:render',
    expect.objectContaining({
      recipe: expect.objectContaining({ denoiseOptions })
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

it('keeps untouched camera framing and grain seed clean when returning to the queue', async () => {
  const crop = { x: 0, y: 0.125, width: 1, height: 0.75 }
  const recipe = { ...defaultRecipe(), crop, seed: 123456 }
  const real = invoke.getMockImplementation()!
  invoke.mockImplementation((command, payload) =>
    command === 'editor:open'
      ? Promise.resolve({ ...session(), recipe, asShotCrop: crop })
      : real(command, payload)
  )
  await editor.getState().open(file)
  expect(await editor.getState().flush()).toBe(true)
  expect(await editor.getState().flush()).toBe(true)
  expect(await editor.getState().close()).toBe(true)
  expect(invoke.mock.calls.some(([command]) => command === 'editor:save')).toBe(false)
  expect(queue.getState().files[0].edit).toBeUndefined()
  expect(editor.getState().documents[file.path]).toMatchObject({
    recipe,
    revision: 0,
    dirty: false,
    storage: 'none',
    past: []
  })
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
    edit: { recipe, revision: 0, sourceRevision: 'source-a' }
  })
  expect(invoke).toHaveBeenCalledWith('editor:preview', {
    path: file.path,
    recipe,
    revision: 0,
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
          revision: 0,
          sourceRevision: 'source-a'
        })
      ]
    })
  )
  expect(invoke.mock.calls.some(([command]) => command === 'editor:save')).toBe(false)
  expect(queue.getState().files[0].edit).toBeUndefined()
  expect(editor.getState().documents[file.path].past).toHaveLength(0)
})

it('does not save a canceled gesture when compare, crop mode and closing flush the session', async () => {
  await editor.getState().open(file)
  editor.getState().change({ exposure: 2 }, false)
  editor.getState().change({ exposure: 0 }, false)
  editor.getState().compare(true)
  editor.getState().compare(false)
  editor.getState().setCropping(true)
  editor.getState().change({ crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }, false)
  editor.getState().change({ crop: null }, false)
  editor.getState().setCropping(false)
  expect(await editor.getState().close()).toBe(true)
  expect(invoke.mock.calls.some(([command]) => command === 'editor:save')).toBe(false)
  expect(queue.getState().files[0].edit).toBeUndefined()
  expect(editor.getState().documents[file.path]).toMatchObject({ revision: 0, past: [] })
})

it('leaves untouched photos clean through navigation and native close', async () => {
  const other = { id: 'b', path: '/photos/b.X3F', fileName: 'b.X3F' }
  queue.setState({ files: [file, other] })
  const real = invoke.getMockImplementation()!
  invoke.mockImplementation((command, payload) =>
    command === 'editor:open'
      ? Promise.resolve({ ...session(), path: payload.path, sessionId: `session:${payload.path}` })
      : real(command, payload)
  )
  await editor.getState().open(file)
  await editor.getState().open(other)
  expect(editor.getState().session?.path).toBe(other.path)
  renderHook(() => useIpcEvents())
  await act(async () => {
    events.get('editor:closing')?.({ quit: true } as never)
    await tick()
  })
  expect(invoke).toHaveBeenCalledWith('editor:finishClose', { quit: true })
  expect(invoke.mock.calls.some(([command]) => command === 'editor:save')).toBe(false)
  expect(queue.getState().files.every((item) => !item.edit)).toBe(true)
  expect(
    Object.values(editor.getState().documents).every((doc) => !doc.dirty && doc.revision === 0)
  ).toBe(true)
})

it('preserves an existing saved edit without saving an unchanged session again', async () => {
  const saved = {
    recipe: { ...defaultRecipe(), exposure: 1, seed: 789 },
    revision: 4,
    sourceRevision: 'source-a',
    storage: 'backup' as const,
    storagePath: '/backup/a.json',
    previewUrl: 'existing-edit'
  }
  queue.setState({ files: [{ ...file, edit: saved }] })
  const real = invoke.getMockImplementation()!
  invoke.mockImplementation((command, payload) =>
    command === 'editor:open' ? Promise.resolve({ ...session(), ...saved }) : real(command, payload)
  )
  await editor.getState().open(queue.getState().files[0])
  expect(await editor.getState().close()).toBe(true)
  expect(invoke.mock.calls.some(([command]) => command === 'editor:save')).toBe(false)
  expect(queue.getState().files[0].edit).toEqual(saved)
  expect(editor.getState().documents[file.path]).toMatchObject({ ...saved, dirty: false })
})

it.each(['Neutral', 'Monochrome'])(
  'keeps Reset and Before clean for a fresh %s camera recipe with its crop and seed',
  async (cameraProfile) => {
    const crop = { x: 0, y: 0.125, width: 1, height: 0.75 }
    const recipe: EditRecipe = {
      ...defaultRecipe(),
      film: null,
      cameraProfile,
      monochrome: cameraProfile === 'Monochrome' ? { filter: 'neutral' } : null,
      crop,
      seed: 123456
    }
    const real = invoke.getMockImplementation()!
    invoke.mockImplementation((command, payload) =>
      command === 'editor:open'
        ? Promise.resolve({
            ...session(),
            recipe,
            asShotCrop: crop,
            asShotCameraProfile: cameraProfile
          })
        : real(command, payload)
    )
    await editor.getState().open(file)
    editor.getState().reset()
    editor.getState().compare(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledWith('editor:render', expect.objectContaining({ recipe }))
    editor.getState().compare(false)
    expect(await editor.getState().close()).toBe(true)
    expect(invoke.mock.calls.some(([command]) => command === 'editor:save')).toBe(false)
    expect(queue.getState().files[0].edit).toBeUndefined()
    expect(editor.getState().documents[file.path]).toMatchObject({ recipe, revision: 0, past: [] })
  }
)

it('restores the as-shot camera look for Reset and Before while preserving actual edits and history', async () => {
  const crop = { x: 0, y: 0.125, width: 1, height: 0.75 }
  const editedCrop = { x: 0.1, y: 0.2, width: 0.7, height: 0.6 }
  const recipe = {
    ...defaultRecipe(),
    cameraProfile: 'Vivid',
    exposure: 2,
    crop: editedCrop,
    seed: 456
  }
  const original = { ...defaultRecipe(), film: null, cameraProfile: 'Neutral', crop, seed: 456 }
  const real = invoke.getMockImplementation()!
  invoke.mockImplementation((command, payload) =>
    command === 'editor:open'
      ? Promise.resolve({
          ...session(),
          recipe,
          revision: 4,
          storage: 'sidecar',
          asShotCrop: crop,
          asShotCameraProfile: 'Neutral'
        })
      : real(command, payload)
  )
  await editor.getState().open(file)
  editor.getState().compare(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenCalledWith(
    'editor:render',
    expect.objectContaining({ recipe: { ...original, crop: editedCrop } })
  )
  expect(editor.getState().documents[file.path].recipe).toEqual(recipe)
  expect(invoke.mock.calls.some(([command]) => command === 'editor:save')).toBe(false)
  editor.getState().compare(false)
  editor.getState().reset()
  expect(await editor.getState().flush()).toBe(true)
  expect(queue.getState().files[0].edit).toMatchObject({ recipe: original, revision: 5 })
  editor.getState().undo()
  expect(await editor.getState().flush()).toBe(true)
  expect(queue.getState().files[0].edit?.recipe).toEqual(recipe)
  editor.getState().redo()
  expect(await editor.getState().flush()).toBe(true)
  expect(queue.getState().files[0].edit?.recipe).toEqual(original)
})

it('treats Reset back to the camera defaults as unedited and keeps undo history on reopen', async () => {
  const defaults = { ...defaultRecipe(), film: null, cameraProfile: 'Standard', seed: 7 }
  const other: X3FFileDTO = { id: 'b', path: '/photos/b.X3F', fileName: 'b.X3F' }
  queue.setState({ files: [file, other] })
  const real = invoke.getMockImplementation()!
  invoke.mockImplementation(async (command, payload) => {
    if (command === 'editor:open')
      // Opening removes stored defaults: the session has no edits.
      return {
        ...session(),
        sessionId: `session:${payload.path}`,
        path: payload.path,
        recipe: defaults,
        asShotCameraProfile: 'Standard'
      }
    const result = await real(command, payload)
    // The backend flags a saved recipe that equals the photo's defaults.
    if (command === 'editor:save')
      return { ...result, edited: (payload.recipe as EditRecipe).exposure !== 0 }
    return result
  })
  await editor.getState().open(file)
  editor.getState().change({ exposure: 1 })
  expect(await editor.getState().flush()).toBe(true)
  expect(queue.getState().files[0].edit).toMatchObject({ revision: 1 })
  editor.getState().reset()
  expect(await editor.getState().flush()).toBe(true)
  expect(queue.getState().files[0].edit).toBeUndefined()
  expect(editor.getState().documents[file.path]).toMatchObject({ revision: 2, storage: 'none' })
  await editor.getState().open(other)
  await editor.getState().open(file)
  expect(editor.getState().documents[file.path].revision).toBe(2)
  editor.getState().undo()
  expect(await editor.getState().flush()).toBe(true)
  expect(queue.getState().files[0].edit).toMatchObject({ recipe: { exposure: 1 }, revision: 3 })
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
  // An untouched photo sends no recipe: the backend renders its camera defaults.
  expect(invoke).toHaveBeenCalledWith('editor:preview', {
    path: other.path,
    recipe: undefined,
    revision: 0,
    sourceRevision: undefined
  })
  expect(request.files[1]).toMatchObject({ sourceRevision: `source:${other.path}` })
  expect(request.files[1].recipe).toBeUndefined()
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

/** Answer renders like geometry.rs: native when the region fits maxEdge. */
function nativeRenders(hold: (payload: Record<string, unknown>) => boolean = () => false) {
  const real = invoke.getMockImplementation()!
  const pending: Array<{
    payload: Record<string, unknown>
    finish: () => void
    fail: () => void
  }> = []
  let serial = 0
  invoke.mockImplementation((command: string, payload: Record<string, unknown>) => {
    if (command !== 'editor:render') return real(command, payload)
    const answer = (): Record<string, unknown> => {
      const [W, H] = [6000, 4000]
      const maxEdge = payload.maxEdge as number
      const url = `x3f-preview://native/${++serial}`
      const r = payload.region as { x: number; y: number; width: number; height: number }
      const common = { sessionId: payload.sessionId, revision: payload.revision, url }
      if (!r)
        return {
          ...common,
          width: maxEdge,
          height: Math.round((maxEdge * H) / W),
          fullWidth: W,
          fullHeight: H
        }
      const factor = Math.min(1, maxEdge / Math.max(r.width * W, r.height * H))
      const [fw, fh] = [Math.round(W * factor), Math.round(H * factor)]
      const x0 = Math.floor(r.x * fw)
      const y0 = Math.floor(r.y * fh)
      const x1 = Math.min(fw, Math.ceil((r.x + r.width) * fw))
      const y1 = Math.min(fh, Math.ceil((r.y + r.height) * fh))
      return {
        ...common,
        width: x1 - x0,
        height: y1 - y0,
        fullWidth: W,
        fullHeight: H,
        region: { x: x0 / fw, y: y0 / fh, width: (x1 - x0) / fw, height: (y1 - y0) / fh }
      }
    }
    if (!hold(payload)) return Promise.resolve(answer())
    return new Promise((resolve, reject) =>
      pending.push({
        payload,
        finish: () => resolve(answer()),
        fail: () => reject(new Error('Rendering cancelled'))
      })
    )
  })
  return pending
}
const renderRequests = (): Array<Record<string, unknown>> =>
  invoke.mock.calls.filter(([command]) => command === 'editor:render').map(([, payload]) => payload)

it('prefetches sharp blocks around a zoomed view after an edit, then refreshes the stale base', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(200)
  nativeRenders()
  const viewport = { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }
  editor.getState().setViewport(viewport)
  await vi.advanceTimersByTimeAsync(0)
  expect(editor.getState().cache?.renders).toHaveLength(1)
  const base = editor.getState().preview
  expect(previewCurrent(editor.getState())).toBe(true)
  invoke.mockClear()
  editor.getState().change({ exposure: 1 })
  expect(editor.getState().cache).toBeNull()
  // The whole-image preview shows the old exposure until prefetch refreshes it.
  await vi.advanceTimersByTimeAsync(0)
  expect(editor.getState().preview).toBe(base)
  expect(previewCurrent(editor.getState())).toBe(false)
  await vi.advanceTimersByTimeAsync(5000)
  expect(previewCurrent(editor.getState())).toBe(true)
  const requests = renderRequests()
  // The visible area (interactive, then refined), four ring blocks, then the base.
  expect(requests.map((request) => [!!request.region, request.maxEdge])).toEqual([
    [true, 1024],
    [true, 4096],
    [true, 4096],
    [true, 4096],
    [true, 4096],
    [true, 4096],
    [false, 2048]
  ])
  expect(requests.slice(2).every((request) => request.interactive === true)).toBe(true)
  expect(requests.every((request) => (request.recipe as EditRecipe).exposure === 1)).toBe(true)
  const { cache, preview } = editor.getState()
  // The interactive and refined renders of the view cover one region: kept once.
  expect(cache?.renders).toHaveLength(5)
  expect(nextPrefetch(cache!, viewport, new Set())).toBeNull()
  expect(preview?.url).not.toBe(base?.url)
  expect(preview?.region).toBeUndefined()
  expect(editor.getState().rendering).toBe(false)
  expect(editor.getState().prefetching).toBe(false)
  // A pan keeps the cache and still renders the visible area first.
  invoke.mockClear()
  const kept = cache!.renders[0]
  editor.getState().setViewport({ ...viewport, x: 0.43 })
  await vi.advanceTimersByTimeAsync(0)
  expect(renderRequests()).toHaveLength(1)
  expect(renderRequests()[0]).toMatchObject({ region: { ...viewport, x: 0.43 }, maxEdge: 4096 })
  expect(editor.getState().cache?.renders[0]).toBe(kept)
})

it('holds prefetch while the view moves and starts it after the view rests', async () => {
  const now = vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(200)
  nativeRenders()
  editor.getState().setViewport({ x: 0.4, y: 0.4, width: 0.1, height: 0.1 })
  await vi.advanceTimersByTimeAsync(0)
  invoke.mockClear()
  for (let step = 0; step < 10; step++) {
    editor.getState().holdPrefetch()
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(renderRequests()).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(299)
  expect(renderRequests()).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(renderRequests()).toHaveLength(1)
  expect(renderRequests()[0]).toMatchObject({ interactive: true, maxEdge: 4096 })
  now.mockRestore()
})

it('stops a prefetch block in flight when the view moves and renders it after rest', async () => {
  const now = vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(200)
  nativeRenders()
  editor.getState().setViewport({ x: 0.4, y: 0.4, width: 0.1, height: 0.1 })
  await vi.advanceTimersByTimeAsync(0)
  const pending = nativeRenders(() => true)
  await vi.advanceTimersByTimeAsync(400)
  expect(pending).toHaveLength(1)
  const block = pending[0].payload.region
  invoke.mockClear()
  editor.getState().holdPrefetch()
  editor.getState().holdPrefetch()
  expect(invoke.mock.calls.filter(([command]) => command === 'editor:cancelRender')).toEqual([
    ['editor:cancelRender', { sessionId: 'session-a', revision: pending[0].payload.revision }]
  ])
  // The view rests where it started, so no render follows, and the
  // cancellation settles after the hold ends.
  await vi.advanceTimersByTimeAsync(120)
  editor.getState().setViewport({ x: 0.4, y: 0.4, width: 0.1, height: 0.1 })
  await vi.advanceTimersByTimeAsync(281)
  expect(pending).toHaveLength(1)
  pending[0].fail()
  await tick()
  expect(editor.getState().prefetching).toBe(false)
  await vi.advanceTimersByTimeAsync(399)
  expect(pending).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(pending).toHaveLength(2)
  expect(pending[1].payload.region).toEqual(block)
  expect(pending[1].payload.revision).toBeGreaterThan(pending[0].payload.revision as number)
  nativeRenders()
  pending[1].finish()
  await vi.advanceTimersByTimeAsync(5000)
  expect(editor.getState().prefetching).toBe(false)
  now.mockRestore()
})

it('cancels prefetch for an edit and drops its old-recipe block', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(200)
  nativeRenders()
  editor.getState().setViewport({ x: 0.4, y: 0.4, width: 0.1, height: 0.1 })
  await vi.advanceTimersByTimeAsync(0)
  const pending = nativeRenders(() => true)
  await vi.advanceTimersByTimeAsync(400)
  expect(pending).toHaveLength(1)
  expect(editor.getState().prefetching).toBe(true)
  expect(editor.getState().rendering).toBe(false)
  // Look thumbnails wait; a thumbnail request would cancel the block.
  expect(await editor.getState().renderThumbnail(defaultRecipe())).toBeNull()
  const oldKey = editor.getState().cache!.key
  const seen: Array<string | undefined> = []
  const unsubscribe = editor.subscribe((state) => seen.push(state.cache?.key))
  editor.getState().change({ exposure: 2 }, false)
  expect(invoke).toHaveBeenCalledWith('editor:cancelRender', {
    sessionId: 'session-a',
    revision: pending[0].payload.revision
  })
  expect(editor.getState().cache).toBeNull()
  pending[0].finish()
  await tick()
  pending.slice(1).forEach((request) => request.finish())
  await tick()
  unsubscribe()
  expect(seen).not.toContain(oldKey)
})

it('lets a pan interrupt prefetch and requests the interrupted block again later', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(200)
  nativeRenders()
  const viewport = { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }
  editor.getState().setViewport(viewport)
  await vi.advanceTimersByTimeAsync(0)
  const pending = nativeRenders(() => true)
  await vi.advanceTimersByTimeAsync(400)
  const block = pending[0].payload.region
  invoke.mockClear()
  const next = { ...viewport, y: 0.401 }
  editor.getState().setViewport(next)
  expect(invoke).toHaveBeenCalledWith('editor:cancelRender', {
    sessionId: 'session-a',
    revision: pending[0].payload.revision
  })
  pending[0].fail()
  await tick()
  expect(editor.getState().cache?.renders.length).toBeGreaterThan(0)
  for (let i = 0; i < 20; ++i) {
    pending.slice(1).forEach((request) => request.finish())
    await vi.advanceTimersByTimeAsync(500)
  }
  expect(renderRequests()[0]).toMatchObject({ region: next, maxEdge: 4096 })
  expect(
    renderRequests().some((request) => JSON.stringify(request.region) === JSON.stringify(block))
  ).toBe(true)
  expect(nextPrefetch(editor.getState().cache!, next, new Set())).toBeNull()
})

it('starts prefetch only after a look thumbnail in flight finishes', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(200)
  nativeRenders()
  const pending = nativeRenders((payload) => payload.maxEdge === 240)
  editor.getState().setViewport({ x: 0.4, y: 0.4, width: 0.1, height: 0.1 })
  await vi.advanceTimersByTimeAsync(0)
  const thumbnail = editor.getState().renderThumbnail(defaultRecipe())
  invoke.mockClear()
  await vi.advanceTimersByTimeAsync(1000)
  expect(renderRequests()).toHaveLength(0)
  pending[0].finish()
  expect(await thumbnail).toMatch(/^x3f-preview:/)
  await vi.advanceTimersByTimeAsync(400)
  expect(renderRequests().length).toBeGreaterThan(0)
  expect(renderRequests()[0]).toMatchObject({ interactive: true, maxEdge: 4096 })
})

it('refreshes a stale base after an edit while zoomed, even when the view is too wide for native blocks', async () => {
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(200)
  nativeRenders()
  // 4500 px across: wider than the renderer's 4096 px region limit.
  const region = { x: 0.1, y: 0.1, width: 0.75, height: 0.75 }
  editor.getState().setViewport(region)
  await vi.advanceTimersByTimeAsync(0)
  expect(editor.getState().tile?.width).toBe(4096)
  const base = editor.getState().preview
  invoke.mockClear()
  editor.getState().change({ exposure: 1 })
  await vi.advanceTimersByTimeAsync(2000)
  const requests = renderRequests()
  expect(requests.map((request) => [!!request.region, request.maxEdge])).toEqual([
    [true, 1024],
    [true, 4096],
    [false, 2048]
  ])
  expect((requests[2].recipe as EditRecipe).exposure).toBe(1)
  expect(editor.getState().cache).toBeNull()
  expect(editor.getState().preview?.url).not.toBe(base?.url)
  // Fresh now: nothing more until the next change.
  invoke.mockClear()
  editor.getState().setViewport({ ...region, x: 0.2 })
  await vi.advanceTimersByTimeAsync(2000)
  expect(renderRequests()).toHaveLength(1)
})

/** Mocks an X3I whose merge waits for `finish`, and returns the test's view of it. */
function mockX3i(processed = false): {
  finish: () => void
  sources: () => Array<string | undefined>
  recipe: () => EditRecipe
} {
  let status: X3iStatus = { frames: 7, processed }
  let finish = (): void => {}
  const base = invoke.getMockImplementation()!
  invoke.mockImplementation(async (command: string, payload: Record<string, unknown>) => {
    if (command === 'editor:open') return { ...session(), x3i: status }
    if (command === 'editor:x3iStatus') return status
    if (command === 'editor:x3iCancel') return undefined
    if (command === 'editor:x3iDelete') {
      status = { frames: 7, processed: false }
      return undefined
    }
    if (command === 'editor:x3iProcess') {
      status = { frames: 7, processed: false, progress: 0.5 }
      return new Promise<void>((resolve) => {
        finish = () => {
          status = { frames: 7, processed: true, name: 'a-0123.sfd', bytes: 100 }
          resolve()
        }
      })
    }
    return base(command, payload)
  })
  return {
    finish: () => finish(),
    sources: () =>
      invoke.mock.calls
        .filter(([command]) => command === 'editor:render')
        .map(([, payload]) => (payload.recipe as EditRecipe).x3iSource),
    recipe: () => editor.getState().documents[file.path].recipe
  }
}

it('opens an X3I with its unfused RAW, edits it during a merge, then uses the SFD RAW', async () => {
  const x3i = mockX3i()
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(500)
  expect(x3i.sources().length).toBeGreaterThan(0)
  expect(new Set(x3i.sources())).toEqual(new Set([undefined]))
  editor.getState().processX3i()
  await vi.advanceTimersByTimeAsync(10)
  expect(editor.getState().x3i?.progress).toBeDefined()
  // Edits apply to the unfused RAW while the frames merge.
  invoke.mockClear()
  editor.getState().change({ exposure: 1 })
  await vi.advanceTimersByTimeAsync(500)
  expect(x3i.sources().length).toBeGreaterThan(0)
  expect(new Set(x3i.sources())).toEqual(new Set([undefined]))
  expect(editor.getState().switching).toBe(false)
  // The photo then changes to the SFD RAW, with the same edits.
  invoke.mockClear()
  x3i.finish()
  await tick()
  expect(x3i.recipe()).toMatchObject({ x3iSource: 'merge', exposure: 1 })
  expect(editor.getState().x3i).toMatchObject({ processed: true, name: 'a-0123.sfd', bytes: 100 })
  expect(editor.getState().switching).toBe(true)
  await vi.advanceTimersByTimeAsync(500)
  expect(x3i.sources().at(-1)).toBe('merge')
  expect(editor.getState().switching).toBe(false)
})

it('cancels a merge, and keeps the unfused RAW even when the merge ends first', async () => {
  const x3i = mockX3i()
  await editor.getState().open(file)
  editor.getState().processX3i()
  await vi.advanceTimersByTimeAsync(10)
  editor.getState().cancelX3i()
  expect(invoke).toHaveBeenCalledWith('editor:x3iCancel', { path: file.path })
  x3i.finish()
  await vi.advanceTimersByTimeAsync(10)
  expect(editor.getState().x3i?.processed).toBe(true)
  expect(x3i.recipe().x3iSource).toBeUndefined()
})

it('changes between the SFD RAW and the unfused RAW in history, and deletes the SFD RAW', async () => {
  const x3i = mockX3i(true)
  await editor.getState().open(file)
  await vi.advanceTimersByTimeAsync(500)
  editor.getState().change({ x3iSource: 'merge' })
  expect(editor.getState().switching).toBe(true)
  await vi.advanceTimersByTimeAsync(500)
  expect(x3i.sources().at(-1)).toBe('merge')
  expect(editor.getState().switching).toBe(false)
  act(() => editor.getState().undo())
  expect(x3i.recipe().x3iSource).toBeUndefined()
  expect(editor.getState().switching).toBe(true)
  act(() => editor.getState().redo())
  await vi.advanceTimersByTimeAsync(500)
  expect(x3i.recipe().x3iSource).toBe('merge')
  // An undo before the change renders, to an SFD RAW that is gone, does not switch.
  editor.getState().change({ x3iSource: undefined })
  expect(editor.getState().switching).toBe(true)
  editor.setState({ x3i: { frames: 7, processed: false } })
  act(() => editor.getState().undo())
  expect(editor.getState().switching).toBe(false)
  editor.setState({ x3i: { frames: 7, processed: true } })
  await vi.advanceTimersByTimeAsync(500)
  // Delete changes to the unfused RAW first, so the photo does not wait for a merge.
  editor.getState().deleteX3i()
  expect(x3i.recipe().x3iSource).toBeUndefined()
  await vi.advanceTimersByTimeAsync(10)
  expect(invoke).toHaveBeenCalledWith('editor:x3iDelete', { path: file.path, recipe: x3i.recipe() })
  expect(editor.getState().x3i?.processed).toBe(false)
  expect(needsX3iMerge(editor.getState())).toBe(false)
  // Undo then needs the SFD RAW again. Other edits wait for its merge.
  act(() => editor.getState().undo())
  expect(x3i.recipe().x3iSource).toBe('merge')
  expect(needsX3iMerge(editor.getState())).toBe(true)
  expect(editor.getState().switching).toBe(false)
  editor.getState().change({ exposure: 1 })
  expect(x3i.recipe().exposure).toBe(0)
  editor.getState().setCropping(true)
  expect(editor.getState().cropping).toBe(false)
})

it('switches to the SFD RAW only at the first status that reports it, and not in Before', async () => {
  let status: X3iStatus = { frames: 7, processed: false }
  let finish!: () => void
  const base = invoke.getMockImplementation()!
  invoke.mockImplementation(async (command: string, payload: Record<string, unknown>) => {
    if (command === 'editor:open') return { ...session(), x3i: status }
    if (command === 'editor:x3iStatus') return status
    if (command === 'editor:x3iDelete') {
      status = { frames: 7, processed: false }
      return undefined
    }
    if (command === 'editor:x3iProcess') {
      status = { frames: 7, processed: false, progress: 0.5 }
      return new Promise<void>((resolve) => (finish = resolve))
    }
    return base(command, payload)
  })
  const recipe = (): EditRecipe => editor.getState().documents[file.path].recipe
  await editor.getState().open(file)
  editor.getState().processX3i()
  await vi.advanceTimersByTimeAsync(10)
  // A poll reports the SFD RAW before the merge request returns.
  status = { frames: 7, processed: true }
  await editor.getState().refreshX3i(true)
  expect(recipe().x3iSource).toBe('merge')
  // The late reply keeps the choice that the user makes next.
  editor.getState().change({ x3iSource: undefined })
  finish()
  await vi.advanceTimersByTimeAsync(10)
  expect(recipe().x3iSource).toBeUndefined()
  // Before rejects the switch. The toggle then shows the unfused RAW.
  editor.getState().deleteX3i()
  await vi.advanceTimersByTimeAsync(10)
  editor.getState().processX3i()
  editor.getState().compare(true)
  status = { frames: 7, processed: true }
  finish()
  await vi.advanceTimersByTimeAsync(10)
  expect(editor.getState().x3i?.processed).toBe(true)
  expect(recipe().x3iSource).toBeUndefined()
  editor.getState().compare(false)
})

it('shows a failed X3I merge request when a late poll and the final status read disagree', async () => {
  const base = invoke.getMockImplementation()!
  let statusCalls = 0
  let poll!: (status: X3iStatus) => void
  let fail!: (error: string) => void
  invoke.mockImplementation(async (command: string, payload: Record<string, unknown>) => {
    if (command === 'editor:open') return { ...session(), x3i: { frames: 7, processed: false } }
    if (command === 'editor:x3iStatus') {
      // The first read is a poll in flight; the final read after the request fails.
      if (++statusCalls === 1) return new Promise((resolve) => (poll = resolve))
      throw new Error('status unavailable')
    }
    if (command === 'editor:x3iProcess') return new Promise((_, reject) => (fail = reject))
    return base(command, payload)
  })
  await editor.getState().open(file)
  editor.getState().processX3i()
  void editor.getState().refreshX3i(true)
  fail('Source missing')
  await tick()
  poll({ frames: 7, processed: false, progress: 0.5 })
  await vi.advanceTimersByTimeAsync(10)
  expect(editor.getState().x3i).toMatchObject({ processed: false, error: 'Source missing' })
  expect(editor.getState().x3i?.progress).toBeUndefined()
})
