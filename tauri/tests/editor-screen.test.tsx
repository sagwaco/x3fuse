// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { defaultRecipe } from '@shared/editor'
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
  ColorScope: ({ url }: { url?: string }) => <div data-scope-url={url} />
}))
vi.mock('../src/renderer/src/components/EditorControls', async () => {
  const { useContext } = await import('react')
  const { DevelopingCloud } = await import('../src/renderer/src/lib/developingCloud')
  return {
    EditorControls: function MockEditorControls({
      setPicking
    }: {
      setPicking: (value: boolean) => void
    }) {
      return (
        <button data-cloud={useContext(DevelopingCloud)} onClick={() => setPicking(true)}>
          Pick white balance
        </button>
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
  const normal = [t('editor.copy'), t('editor.paste'), t('editor.compare'), t('button.convert')]
  for (const name of normal) expect(screen.getByRole('button', { name })).toBeTruthy()
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
  fireEvent.keyDown(document.body, { key: 'c', metaKey: true, shiftKey: true })
  fireEvent.keyDown(document.body, { key: 'v', metaKey: true, shiftKey: true })
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
