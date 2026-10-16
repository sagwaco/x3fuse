// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { DEFAULT_FILM, defaultRecipe } from '@shared/editor'
import { displayPreviewUrl, previewUrl } from '@shared/preview'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'
import { EditorScreen } from '../src/renderer/src/components/EditorScreen'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { t } from '../src/renderer/src/lib/strings'

vi.mock('../src/renderer/src/components/FileFilmstrip', () => ({
  FileFilmstrip: ({ preview }: { preview: ReactNode }) => <main>{preview}</main>
}))
const mounts = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/renderer/src/components/DevelopingPreview', async () => {
  const { useState } = await import('react')
  return {
    DevelopingPreview: function MockDevelopingPreview({
      file,
      matching,
      ready,
      onDone
    }: {
      file: X3FFileDTO
      matching: boolean
      ready: boolean
      onDone: () => void
    }) {
      const [mount] = useState(() => ++mounts.count)
      return ready ? (
        <button data-condensing={file.path} onClick={onDone} />
      ) : (
        <img
          data-placeholder
          data-mount={mount}
          data-matching={matching}
          src={displayPreviewUrl(file)}
          alt={file.fileName}
        />
      )
    }
  }
})
vi.mock('../src/renderer/src/components/ZoomablePreview', () => ({
  ZoomablePreview: ({
    file,
    onImagePoint,
    onPaint
  }: {
    file: X3FFileDTO
    onImagePoint?: unknown
    onPaint?: () => void
  }) => (
    <div data-editor-frame={displayPreviewUrl(file, 'full')} data-picking={!!onImagePoint}>
      <button data-paint onClick={onPaint} />
    </div>
  )
}))
vi.mock('../src/renderer/src/components/CropPreview', () => ({
  CropPreview: ({ onPaint }: { onPaint?: () => void }) => (
    <div data-crop-preview>
      <button data-crop-paint onClick={onPaint} />
    </div>
  )
}))
vi.mock('../src/renderer/src/components/CropControls', () => ({
  CropControls: () => <div data-crop-controls />
}))
vi.mock('../src/renderer/src/components/ColorScope', () => ({
  ColorScope: ({ url, compact }: { url?: string; compact?: boolean }) => (
    <div data-scope-url={url} data-compact={compact} />
  )
}))
vi.mock('../src/renderer/src/components/EditorControls', async () => {
  const { useContext } = await import('react')
  const { DevelopingCloud } = await import('../src/renderer/src/lib/developingCloud')
  const { EmulsionControls } = await vi.importActual<
    typeof import('../src/renderer/src/components/EditorControls')
  >('../src/renderer/src/components/EditorControls')
  return {
    EmulsionControls,
    EditorControls: function MockEditorControls({
      setPicking,
      onNavigate
    }: {
      setPicking: (value: boolean) => void
      onNavigate: (page: 'emulsion') => void
    }) {
      return (
        <>
          <button data-cloud={useContext(DevelopingCloud)} onClick={() => setPicking(true)}>
            Pick white balance
          </button>
          <button data-sidebar-page="emulsion" onClick={() => onNavigate('emulsion')}>
            Choose emulsion
          </button>
        </>
      )
    }
  }
})
vi.mock('../src/renderer/src/components/BatchProgress', () => ({ BatchProgress: () => null }))
vi.mock('../src/renderer/src/components/ScopeMenu', () => ({ ScopeMenu: () => null }))
vi.mock('../src/renderer/src/components/ZoomControls', () => ({ ZoomControls: () => null }))
vi.mock('../src/renderer/src/components/ui/resizablePanel', () => ({
  ResizablePanel: ({ children }: { children: ReactNode }) => <aside>{children}</aside>
}))

const initialEditor = editor.getState()
const initialQueue = queue.getState()
const initialSettings = useSettingsStore.getState()
const recipe = defaultRecipe()
const file: X3FFileDTO = {
  id: 'a',
  path: '/photos/a.X3F',
  fileName: 'a.X3F',
  edit: {
    recipe,
    revision: 1,
    sourceRevision: 'source-a',
    storage: 'sidecar',
    previewUrl: 'x3f-edit://localhost/saved-a'
  }
}
const session = {
  ...file.edit!,
  path: file.path,
  sessionId: 'session-a'
}
const doc = { ...file.edit!, past: [], future: [], dirty: false }
const frame = {
  sessionId: session.sessionId,
  revision: 1,
  url: 'x3f-edit://localhost/live-a',
  width: 1024,
  height: 683
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  editor.setState({ ...initialEditor, loading: true, open: vi.fn(async () => {}) }, true)
  queue.setState({
    files: [file],
    activeId: file.id,
    selectedIds: new Set([file.id]),
    isProcessing: false,
    isPreparing: false
  })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
})
afterEach(() => {
  cleanup()
  editor.setState(initialEditor, true)
  queue.setState(initialQueue, true)
  useSettingsStore.setState(initialSettings, true)
  vi.unstubAllGlobals()
})

it('shows the saved thumbnail during RAW preparation and enables editing only for the live frame', () => {
  const view = render(<EditorScreen />)
  expect(screen.getByRole('img').getAttribute('src')).toBe(
    'x3f-edit://localhost/saved-a?v=thumbnail'
  )
  expect((screen.getByRole('button', { name: 'Crop' }) as HTMLButtonElement).disabled).toBe(true)
  expect(view.container.querySelector('[data-editor-frame]')).toBeNull()
  act(() =>
    editor.setState({ session, documents: { [file.path]: doc }, loading: false, rendering: true })
  )
  expect(screen.getByRole('button', { name: 'Pick white balance' }).matches(':disabled')).toBe(true)
  // Screen readers hear the developing status; the cloud is the visible one.
  expect(screen.getByText('Developing RAW preview…').className).toBe('sr-only')
  expect(screen.getByText('Developing RAW preview…').closest('[role=status]')).not.toBeNull()
  act(() => editor.setState({ preview: { ...frame, draft: true }, rendering: false }))
  // The thumbnail stays until the first preview paints, then the cloud condenses and leaves.
  expect(view.container.querySelector('[data-placeholder]')).not.toBeNull()
  fireEvent.click(view.container.querySelector('[data-paint]')!)
  expect(view.container.querySelector('[data-placeholder]')).toBeNull()
  const condensing = view.container.querySelector('[data-condensing]')!
  expect(condensing.getAttribute('data-condensing')).toBe(file.path)
  // The scope and the controls wait until the cloud leaves.
  expect(view.container.querySelector('[data-scope-url]')).toBeNull()
  const pick = (): HTMLElement => screen.getByRole('button', { name: 'Pick white balance' })
  expect(pick().matches(':disabled')).toBe(true)
  expect(pick().getAttribute('data-cloud')).toBe('true')
  fireEvent.click(condensing)
  expect(pick().getAttribute('data-cloud')).toBe('false')
  expect(view.container.querySelector('[data-condensing]')).toBeNull()
  expect(view.container.querySelector('[data-scope-url]')?.getAttribute('data-scope-url')).toBe(
    frame.url
  )
  expect(
    view.container.querySelector('[data-editor-frame]')?.getAttribute('data-editor-frame')
  ).toBe(frame.url)
  expect(screen.queryByText('Developing RAW preview…')).toBeNull()
  expect((screen.getByRole('button', { name: 'Crop' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Pick white balance' }))
  expect(view.container.querySelector('[data-editor-frame]')?.getAttribute('data-picking')).toBe(
    'true'
  )
  const region = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
  act(() =>
    editor.setState({
      viewport: region,
      tile: { ...frame, draft: false, region, viewport: region }
    })
  )
})

it('draws the Before pill as a glass overlay', () => {
  editor.setState({
    session,
    documents: { [file.path]: doc },
    preview: { ...frame, draft: true },
    loading: false,
    before: true
  })
  render(<EditorScreen />)
  expect(screen.getByText(t('editor.before')).classList.contains('glass-overlay')).toBe(true)
})

it('gives focus back to Crop after the toolbar exit animation ends', async () => {
  const finishers: Array<() => void> = []
  Element.prototype.animate = function () {
    const finished = new Promise<void>((resolve) => finishers.push(resolve))
    return { finished, cancel: () => {} } as unknown as Animation
  }
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('CSS', { supports: () => true })
  try {
    editor.setState({
      session: { ...session, asShotCrop: null },
      documents: { [file.path]: doc },
      preview: { ...frame, sourceWidth: 6000, sourceHeight: 4000 },
      loading: false
    })
    render(<EditorScreen />)
    fireEvent.click(screen.getByRole('button', { name: t('editor.crop') }))
    await act(async () => finishers.splice(0).forEach((finish) => finish()))
    // Entering crop mode clears the preview; the next render brings it back.
    act(() => editor.setState({ preview: { ...frame, sourceWidth: 6000, sourceHeight: 4000 } }))
    const apply = screen.getByRole('button', { name: t('editor.applyCrop') })
    apply.focus()
    fireEvent.click(apply)
    // The crop toolbar stays, inert, until its exit ends.
    expect(screen.queryByRole('button', { name: t('editor.crop') })).toBeNull()
    await act(async () => finishers.splice(0).forEach((finish) => finish()))
    // Crop stays disabled, and keeps no focus, until the next preview arrives.
    act(() => editor.setState({ preview: frame }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('editor.crop') }))
  } finally {
    // @ts-expect-error remove the mock again
    delete Element.prototype.animate
    vi.unstubAllGlobals()
  }
})

it('replaces the old session immediately on selection and uses embedded pixels only for unedited files', () => {
  const next = { id: 'b', path: '/photos/b.X3F', fileName: 'b.X3F' }
  queue.setState({ files: [file, next] })
  editor.setState({
    session,
    documents: { [file.path]: doc },
    preview: frame,
    loading: false,
    cropping: true
  })
  const view = render(<EditorScreen />)
  expect(view.container.querySelector('[data-crop-preview]')).not.toBeNull()
  act(() => {
    editor.setState({ loading: true })
    queue.setState({ activeId: next.id })
  })
  expect(screen.getByRole('img').getAttribute('src')).toBe(
    previewUrl(next.path, 'preview', next.id)
  )
  expect(screen.getByRole('img').getAttribute('alt')).toBe(next.fileName)
  expect(
    view.container.querySelector('[data-editor-frame], [data-crop-preview], [data-scope-url]')
  ).toBeNull()
  expect((screen.getByRole('button', { name: 'Apply crop' }) as HTMLButtonElement).disabled).toBe(
    true
  )
})

it('develops every photo, but trusts saved pixels only when they show the current edit', () => {
  editor.setState({
    session,
    documents: { [file.path]: { ...doc, recipe: { ...recipe, exposure: 2 } } }
  })
  const view = render(<EditorScreen />)
  const matching = (): string | null | undefined =>
    view.container.querySelector('[data-placeholder]')?.getAttribute('data-matching')
  // A placeholder decides its pixels once, so a new answer mounts a new one.
  const mount = (): string | null | undefined =>
    view.container.querySelector('[data-placeholder]')?.getAttribute('data-mount')
  expect(matching()).toBe('false')
  const first = mount()
  act(() => editor.setState({ documents: { [file.path]: { ...doc, gesture: recipe } } }))
  expect(matching()).toBe('false')
  act(() => editor.setState({ documents: { [file.path]: { ...doc, dirty: true } } }))
  expect(matching()).toBe('false')
  expect(mount()).toBe(first)
  act(() => editor.setState({ documents: { [file.path]: doc } }))
  expect(matching()).toBe('true')
  expect(mount()).not.toBe(first)
  // Crop mode shows the uncropped photo, which saved pixels do not.
  act(() => editor.setState({ cropping: true }))
  expect(matching()).toBe('false')
  act(() => editor.setState({ cropping: false }))
  act(() =>
    queue.setState({ files: [{ ...file, edit: { ...file.edit!, previewUrl: undefined } }] })
  )
  expect(matching()).toBe('false')
})

it('swaps the toolbar for crop actions and cancels back to the geometry crop mode began with', () => {
  const change = vi.fn()
  const copy = vi.fn()
  const paste = vi.fn(async () => {})
  const compare = vi.fn()
  const start = { ...recipe, crop: { x: 0.1, y: 0, width: 0.8, height: 1 }, straighten: 2 }
  const at = (next: typeof start): void =>
    editor.setState({ documents: { [file.path]: { ...doc, recipe: next } } })
  const frame3x2 = { ...frame, sourceWidth: 6000, sourceHeight: 4000 }
  editor.setState({
    session: { ...session, asShotCrop: null },
    preview: frame3x2,
    loading: false,
    clipboard: recipe,
    change,
    copy,
    paste,
    compare
  })
  at(start)
  render(<EditorScreen />)
  const normal = [
    t('editor.copy'),
    t('editor.paste'),
    t('editor.reset'),
    t('editor.compare'),
    t('button.convert')
  ]
  for (const name of normal) expect(screen.getByRole('button', { name })).toBeTruthy()
  // Command-C and Control-V copy and paste adjustments, with or without Shift.
  fireEvent.keyDown(document.body, { key: 'c', metaKey: true })
  fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true })
  fireEvent.keyDown(document.body, { key: 'C', metaKey: true, shiftKey: true })
  expect(copy).toHaveBeenCalledTimes(2)
  expect(paste).toHaveBeenCalledTimes(1)
  // A focused number field keeps its own copy and paste.
  const field = document.createElement('input')
  document.body.append(field)
  fireEvent.keyDown(field, { key: 'c', metaKey: true })
  field.remove()
  expect(copy).toHaveBeenCalledTimes(2)
  copy.mockClear()
  paste.mockClear()
  fireEvent.click(screen.getByRole('button', { name: t('editor.crop') }))
  expect(editor.getState().cropping).toBe(true)
  // Entering crop mode turns off Before, whose recipe would block geometry edits.
  expect(compare).toHaveBeenCalledWith(false)
  compare.mockClear()
  act(() => editor.setState({ preview: frame3x2 }))
  for (const name of [...normal, t('editor.crop'), t('editor.done')])
    expect(screen.queryByRole('button', { name })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: t('editor.rotate') }))
  expect(change).toHaveBeenLastCalledWith({ rotation: 1 })
  fireEvent.click(screen.getByRole('button', { name: t('editor.rotateLeft') }))
  expect(change).toHaveBeenLastCalledWith({ rotation: 3 })
  // Reset lives at the top of the crop section (editor-controls tests).
  expect(screen.queryByRole('button', { name: t('editor.resetCrop') })).toBeNull()
  // Hidden actions keep their shortcuts quiet while cropping.
  fireEvent.keyDown(document.body, { key: 'c', metaKey: true })
  fireEvent.keyDown(document.body, { key: 'v', metaKey: true })
  fireEvent.keyDown(document.body, { key: '\\' })
  expect(copy).not.toHaveBeenCalled()
  expect(paste).not.toHaveBeenCalled()
  expect(compare).not.toHaveBeenCalled()
  // Cancel puts back the geometry from when crop mode opened, as one change.
  act(() => at({ ...start, straighten: 9, pitch: 5, rotation: 1 }))
  change.mockClear()
  fireEvent.click(screen.getByRole('button', { name: t('button.cancel') }))
  expect(change).toHaveBeenCalledTimes(1)
  expect(change).toHaveBeenLastCalledWith({
    crop: start.crop,
    rotation: 0,
    straighten: 2,
    pitch: 0,
    yaw: 0
  })
  expect(editor.getState().cropping).toBe(false)
  // Escape cancels too; with nothing changed, it only leaves crop mode.
  act(() => at(start))
  act(() => editor.setState({ preview: frame3x2 }))
  fireEvent.click(screen.getByRole('button', { name: t('editor.crop') }))
  change.mockClear()
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(change).not.toHaveBeenCalled()
  expect(editor.getState().cropping).toBe(false)
  // Apply keeps the edits and leaves crop mode.
  act(() => editor.setState({ preview: frame3x2 }))
  fireEvent.click(screen.getByRole('button', { name: t('editor.crop') }))
  act(() => {
    at({ ...start, pitch: 4 })
    editor.setState({ preview: frame3x2 })
  })
  change.mockClear()
  fireEvent.click(screen.getByRole('button', { name: t('editor.applyCrop') }))
  expect(change).not.toHaveBeenCalled()
  expect(editor.getState().cropping).toBe(false)
})

it('keeps crop mode safe from compare, paste, held Escape and lost focus', () => {
  editor.setState({
    session,
    preview: { ...frame, sourceWidth: 6000, sourceHeight: 4000 },
    loading: false
  })
  editor.setState({ documents: { [file.path]: doc } })
  render(<EditorScreen />)
  const cropButton = screen.getByRole('button', { name: t('editor.crop') })
  cropButton.focus()
  fireEvent.click(cropButton)
  // Compare and paste wait while cropping, also from the native menu.
  editor.getState().compare(true)
  expect(editor.getState().before).toBe(false)
  editor.setState({ clipboard: { ...recipe, exposure: 2 } })
  void editor.getState().paste()
  expect(editor.getState().documents[file.path].recipe.exposure).toBe(0)
  // Holding Escape repeats the key: only the first press may cancel crop mode.
  fireEvent.keyDown(document.body, { key: 'Escape', repeat: true })
  expect(editor.getState().cropping).toBe(true)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(editor.getState().cropping).toBe(false)
  // Focus goes back to the Crop button once the next preview enables it.
  const button = screen.getByRole('button', { name: t('editor.crop') }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(document.activeElement).not.toBe(button)
  act(() => editor.setState({ preview: { ...frame, sourceWidth: 6000, sourceHeight: 4000 } }))
  expect(document.activeElement).toBe(button)
  expect(editor.getState().session).not.toBeNull()
})

it('ends crop mode when the editor screen goes away, as for Export', () => {
  editor.setState({ session, documents: { [file.path]: doc }, preview: frame, loading: false })
  const view = render(<EditorScreen />)
  fireEvent.click(screen.getByRole('button', { name: t('editor.crop') }))
  expect(editor.getState().cropping).toBe(true)
  view.unmount()
  expect(editor.getState().cropping).toBe(false)
})

it('drops a paste whose photos finish loading after crop mode opened', async () => {
  let finish: (records: unknown[]) => void = () => {}
  const invoke = vi.fn((channel: string) =>
    channel === 'editor:load' ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(null)
  )
  ;(window as unknown as { x3f: unknown }).x3f = { invoke, on: () => () => {} }
  const other = { id: 'b', path: '/photos/b.X3F', fileName: 'b.X3F' }
  queue.setState({ files: [file, other], selectedIds: new Set([file.id, other.id]) })
  editor.setState({
    session,
    documents: { [file.path]: doc },
    preview: frame,
    loading: false,
    clipboard: { ...recipe, exposure: 2 }
  })
  const pasting = editor.getState().paste()
  editor.getState().setCropping(true)
  finish([{ path: other.path, recipe: defaultRecipe(), sourceRevision: 'source-b', revision: 0 }])
  await act(async () => pasting)
  expect(editor.getState().documents[file.path].recipe.exposure).toBe(0)
  expect(invoke).not.toHaveBeenCalledWith('editor:save', expect.anything())
})

it('makes Cancel one undoable change, even during an unfinished gesture', () => {
  const invoke = vi.fn(async () => null)
  ;(window as unknown as { x3f: unknown }).x3f = { invoke, on: () => () => {} }
  const start = { ...recipe, straighten: 2 }
  editor.setState({
    session,
    documents: { [file.path]: { ...doc, recipe: start, past: [], future: [] } },
    preview: { ...frame, sourceWidth: 6000, sourceHeight: 4000 },
    loading: false
  })
  render(<EditorScreen />)
  const recipeNow = () => editor.getState().documents[file.path].recipe
  fireEvent.click(screen.getByRole('button', { name: t('editor.crop') }))
  act(() => editor.setState({ preview: { ...frame, sourceWidth: 6000, sourceHeight: 4000 } }))
  act(() => editor.getState().change({ straighten: 9 }))
  // A drag still in progress when Cancel is pressed.
  act(() => editor.getState().change({ pitch: 6 }, false))
  fireEvent.click(screen.getByRole('button', { name: t('button.cancel') }))
  expect(recipeNow()).toMatchObject({ straighten: 2, pitch: 0 })
  expect(editor.getState().cropping).toBe(false)
  expect(editor.getState().documents[file.path].future).toEqual([])
  // Undo brings back the last committed geometry before Cancel; the unfinished
  // drag (pitch 6) was never a history step.
  expect(editor.getState().documents[file.path].past.at(-1)).toMatchObject({ straighten: 9 })
  act(() => editor.getState().undo())
  expect(recipeNow()).toMatchObject({ straighten: 9, pitch: 0 })
})

it('condenses the cloud after a second when the first preview cannot paint', () => {
  vi.useFakeTimers()
  try {
    editor.setState({ session, documents: { [file.path]: doc }, loading: false, rendering: true })
    const view = render(<EditorScreen />)
    act(() => editor.setState({ preview: { ...frame, draft: true }, rendering: false }))
    act(() => vi.advanceTimersByTime(999))
    expect(view.container.querySelector('[data-placeholder]')).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(view.container.querySelector('[data-condensing]')).not.toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('waits for a new paint after a crop mode change clears the preview', () => {
  editor.setState({
    session,
    documents: { [file.path]: doc },
    loading: false,
    preview: { ...frame, draft: false }
  })
  const view = render(<EditorScreen />)
  fireEvent.click(view.container.querySelector('[data-paint]')!)
  act(() => editor.setState({ cropping: true, preview: null, rendering: true }))
  expect(view.container.querySelector('[data-placeholder]')).not.toBeNull()
  act(() => editor.setState({ preview: { ...frame, draft: false }, rendering: false }))
  expect(view.container.querySelector('[data-crop-preview]')).not.toBeNull()
  expect(view.container.querySelector('[data-placeholder]')).not.toBeNull()
  fireEvent.click(view.container.querySelector('[data-crop-paint]')!)
  expect(view.container.querySelector('[data-condensing]')).not.toBeNull()
})

it('puts a divider before Done, then the Export menu and the panel toggle', async () => {
  const update = vi.fn(async () => {})
  useSettingsStore.setState({ update })
  editor.setState({ session, documents: { [file.path]: doc }, loading: false, preview: frame })
  const view = render(<EditorScreen />)
  const done = screen.getByRole('button', { name: t('editor.done') })
  expect(done.previousElementSibling?.getAttribute('role')).toBe('separator')
  const exportGroup = screen.getByRole('group', { name: t('batch.convert_options') })
  expect(done.nextElementSibling).toBe(exportGroup)
  const toggle = screen.getByRole('button', { name: t('editor.togglePanel') })
  expect(exportGroup.nextElementSibling).toBe(toggle)
  // Export exports the open photo and comes back to the editor.
  const openExport = vi.fn()
  act(() => queue.setState({ selectedIds: new Set(), openExport }))
  fireEvent.click(screen.getByRole('button', { name: t('button.convert') }))
  expect(openExport).toHaveBeenCalledWith(new Set([file.id]), 'editor')
  // Crop sits before the divider and Done, with its name shown.
  const crop = screen.getByRole('button', { name: t('editor.crop') })
  expect(crop.textContent).toBe(t('editor.crop'))
  expect(crop.nextElementSibling).toBe(done.previousElementSibling)
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(toggle)
  expect(update).toHaveBeenCalledWith({ editorPanelOpen: false })
  // Shortcuts still work while the Export menu button has focus.
  const undo = vi.fn()
  act(() => editor.setState({ undo }))
  fireEvent.keyDown(screen.getByRole('button', { name: t('batch.convert_options') }), {
    key: 'z',
    metaKey: true
  })
  expect(undo).toHaveBeenCalled()
  act(() =>
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, editorPanelOpen: false } })
  )
  expect(view.container.querySelector('aside')).toBeNull()
  // Crop mode keeps the panel open for its controls.
  act(() => editor.setState({ cropping: true }))
  expect(view.container.querySelector('[data-crop-controls]')).not.toBeNull()
})

it('names the photo in the panel header and shows its capture details from the info icon', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const exif = [
    { label: 'Camera', value: 'SIGMA sd Quattro H' },
    { label: 'Focal length', value: '30.0 mm' },
    { label: 'Aperture', value: 'f/4.0' },
    { label: 'Shutter', value: '1/250' },
    { label: 'ISO', value: '100' },
    { label: 'Exposure comp.', value: '-1/3' },
    { label: 'Metering', value: 'Multi-segment' },
    { label: 'Flash', value: 'On, Return detected' },
    { label: 'Dimensions', value: '6192 × 4128' }
  ]
  queue.setState({ files: [{ ...file, exif, fileSize: 52_400_000 }] })
  editor.setState({ session, documents: { [file.path]: doc }, loading: false, preview: frame })
  const view = render(<EditorScreen />)
  // The toolbar starts at the filter button; the name moved to the panel header.
  expect(screen.getByRole('button', { name: t('filter.toggle') }).previousElementSibling).toBeNull()
  const header = view.container.querySelector('aside')!.firstElementChild as HTMLElement
  expect(within(header).getByText(file.fileName)).toBeTruthy()
  expect(within(header).queryByText(t('editor.adjustments'))).toBeNull()
  fireEvent.pointerMove(within(header).getByRole('button', { name: t('editor.photoInfo') }), {
    pointerType: 'mouse'
  })
  const card = await screen.findByRole('tooltip')
  for (const text of [
    'SIGMA sd Quattro H',
    t('editor.noLens'),
    '26 MP',
    '6192 × 4128',
    '52.4 MB',
    'X3F',
    'ISO 100',
    '30 mm',
    '-1/3 ev',
    'ƒ4',
    '1/250 s'
  ])
    expect(card.textContent).toContain(text)
  expect(within(card).getByRole('img', { name: 'Multi-segment' })).toBeTruthy()
  // ExifTool writes On for some flashes that fired, and Off with red-eye for one that did not.
  const flash = (): string | null =>
    within(card).getByRole('img', { name: /^O/ }).firstElementChild!.getAttribute('class')
  expect(flash()).toContain('text-tone-100')
  act(() =>
    queue.setState({
      files: [{ ...file, exif: [...exif, { label: 'Flash', value: 'Off, Red-eye reduction' }] }]
    })
  )
  expect(flash()).not.toContain('text-tone-100')
})

it('toggles the neutral picker with W', () => {
  editor.setState({ session, documents: { [file.path]: doc }, loading: false, preview: frame })
  const view = render(<EditorScreen />)
  const picking = (): string | null | undefined =>
    view.container.querySelector('[data-editor-frame]')?.getAttribute('data-picking')
  fireEvent.keyDown(document, { key: 'w' })
  expect(picking()).toBe('true')
  fireEvent.keyDown(document, { key: 'w', repeat: true })
  expect(picking()).toBe('true')
  fireEvent.keyDown(document, { key: 'W' })
  expect(picking()).not.toBe('true')
  // W waits while the picker's controls are disabled, as in Compare, or a dialog is open.
  act(() => editor.setState({ before: true }))
  fireEvent.keyDown(document, { key: 'w' })
  expect(picking()).not.toBe('true')
  act(() => editor.setState({ before: false }))
  const dialog = document.body.appendChild(document.createElement('div'))
  dialog.setAttribute('role', 'dialog')
  dialog.dataset.state = 'open'
  fireEvent.keyDown(dialog, { key: 'w' })
  expect(picking()).not.toBe('true')
  dialog.remove()
  fireEvent.keyDown(document, { key: 'w' })
  expect(picking()).toBe('true')
})

it('inverts a negative print on request and shows a tiny scope while the scope is scrolled away', () => {
  let report: (entries: Array<{ isIntersecting: boolean }>) => void = () => {}
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof report) {
        report = callback
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
  const negative = { ...recipe, film: { ...DEFAULT_FILM, negative: true } }
  editor.setState({
    session,
    documents: { [file.path]: { ...doc, recipe: negative } },
    loading: false,
    preview: frame
  })
  const view = render(<EditorScreen />)
  const frameBox = (): Element =>
    view.container.querySelector('[data-editor-frame]')!.parentElement!
  expect(frameBox().className).not.toContain('invert')
  act(() => editor.setState({ negativePreview: true }))
  expect(frameBox().className).toContain('invert')
  // Before shows the original photo as it is.
  act(() => editor.setState({ before: true }))
  expect(frameBox().className).not.toContain('invert')
  act(() => editor.setState({ before: false, negativePreview: false }))
  expect(view.container.querySelector('[data-compact="true"]')).toBeNull()
  act(() => report([{ isIntersecting: false }]))
  expect(view.container.querySelector('aside .h-8 [data-compact="true"]')).not.toBeNull()
  act(() => report([{ isIntersecting: true }]))
  expect(view.container.querySelector('[data-compact="true"]')).toBeNull()
  vi.unstubAllGlobals()
})

function openPaper(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Choose emulsion' }))
  fireEvent.click(screen.getByRole('tab', { name: t('editor.darkroom') }))
  fireEvent.click(screen.getByText(t('editor.paperStock'), { selector: '[data-sidebar-page] *' }))
}

it('returns through the Emulsion stack with focus, tab and scroll restored', () => {
  const close = vi.fn(async () => true)
  editor.setState({
    session,
    documents: { [file.path]: doc },
    loading: false,
    preview: frame,
    close,
    renderThumbnail: vi.fn(async () => null)
  })
  const view = render(<EditorScreen />)
  const body = view.container.querySelector('aside .overflow-y-auto')!
  body.scrollTop = 120
  fireEvent.click(screen.getByRole('button', { name: 'Choose emulsion' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Pick white balance' })).toBeNull()
  expect(screen.getByRole('heading', { name: t('editor.cameraMatching') })).toBeTruthy()
  const back = screen.getByRole('button', { name: t('editor.backToAdjustments') })
  expect(document.activeElement).toBe(back)
  expect(back.closest('.overflow-y-auto')).toBeNull()
  expect(body.scrollTop).toBe(0)
  fireEvent.click(screen.getByRole('tab', { name: t('editor.darkroom') }))
  body.scrollTop = 64
  const paper = screen
    .getByText(t('editor.paperStock'), { selector: '[data-sidebar-page] *' })
    .closest('button')!
  fireEvent.click(paper)
  expect(screen.getByRole('heading', { name: t('editor.paperStock') })).toBeTruthy()
  expect(body.scrollTop).toBe(0)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  expect(
    screen.getByRole('tab', { name: t('editor.darkroom') }).getAttribute('aria-selected')
  ).toBe('true')
  expect(document.activeElement).toBe(paper)
  expect(body.scrollTop).toBe(64)
  fireEvent.click(paper)
  fireEvent.click(screen.getByRole('button', { name: t('editor.backToEmulsion') }))
  expect(document.activeElement).toBe(paper)
  fireEvent.click(screen.getByRole('button', { name: t('editor.backToAdjustments') }))
  expect(screen.getByRole('button', { name: 'Pick white balance' })).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose emulsion' }))
  expect(body.scrollTop).toBe(120)
  fireEvent.click(screen.getByRole('button', { name: 'Choose emulsion' }))
  expect(body.scrollTop).toBe(0)
  expect(
    screen.getByRole('tab', { name: t('editor.filmStock') }).getAttribute('aria-selected')
  ).toBe('true')
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose emulsion' }))
  fireEvent.keyDown(document.body, { key: 'Escape', repeat: true })
  expect(close).not.toHaveBeenCalled()
})

it('returns to adjustments when crop opens or the photo changes', () => {
  editor.setState({
    session,
    documents: { [file.path]: doc },
    loading: false,
    preview: frame,
    renderThumbnail: vi.fn(async () => null)
  })
  render(<EditorScreen />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose emulsion' }))
  act(() => editor.setState({ cropping: true }))
  expect(screen.queryByRole('button', { name: t('editor.backToAdjustments') })).toBeNull()
  act(() => editor.setState({ cropping: false }))
  openPaper()
  act(() => editor.setState({ session: { ...session, sessionId: 'new-session' } }))
  expect(screen.queryByRole('button', { name: t('editor.backToEmulsion') })).toBeNull()
  expect(screen.queryByRole('button', { name: t('editor.backToAdjustments') })).toBeNull()
})

it('returns to Emulsion film stocks when undo removes the film from the paper page', () => {
  editor.setState({
    session,
    documents: { [file.path]: doc },
    loading: false,
    preview: frame,
    renderThumbnail: vi.fn(async () => null)
  })
  render(<EditorScreen />)
  openPaper()
  act(() =>
    editor.setState({ documents: { [file.path]: { ...doc, recipe: { ...recipe, film: null } } } })
  )
  expect(screen.queryByRole('heading', { name: t('editor.paperStock') })).toBeNull()
  expect(
    screen.getByRole('tab', { name: t('editor.filmStock') }).getAttribute('aria-selected')
  ).toBe('true')
  expect(
    (screen.getByRole('tab', { name: t('editor.darkroom') }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: t('editor.filmStock') }))
})
