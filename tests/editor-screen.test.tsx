// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { DEFAULT_FILM, defaultRecipe, type PreviewRegion } from '@shared/editor'
import { displayPreviewUrl, previewUrl } from '@shared/preview'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'
import { EditorScreen } from '../src/renderer/src/components/EditorScreen'
import { useEditorStore as editor, geometryKey } from '../src/renderer/src/stores/editorStore'
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
// One test uses the real preview, with frame decoding under its control.
type Decoded = { image: { width: number; height: number }; width: number; height: number }
const real = vi.hoisted(() => ({
  preview: false,
  decode: vi.fn<(url: string, ready: (preview: Decoded) => void) => () => void>(() => () => {})
}))
vi.mock('../src/renderer/src/lib/fitPreviews', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/lib/fitPreviews')>()),
  subscribeFitPreview: real.decode
}))
vi.mock('../src/renderer/src/components/ZoomablePreview', async () => {
  const actual = await vi.importActual<
    typeof import('../src/renderer/src/components/ZoomablePreview')
  >('../src/renderer/src/components/ZoomablePreview')
  type Props = Parameters<typeof actual.ZoomablePreview>[0]
  return {
    ZoomablePreview: (props: Props) =>
      real.preview ? <actual.ZoomablePreview {...props} /> : <MockPreview {...props} />
  }
  function MockPreview({
    file,
    onImagePoint,
    onImageRegion,
    outline,
    onPaint,
    onViewportChange
  }: Props): React.JSX.Element {
    return (
      <div
        data-editor-frame={displayPreviewUrl(file, 'full')}
        data-picking={!!onImagePoint}
        data-qualifying={!!onImageRegion}
        data-outline={outline ? JSON.stringify(outline) : undefined}
        data-viewport={!!onViewportChange}
      >
        {/* The real preview paints a frame only after it decodes. */}
        <button data-paint onClick={() => onPaint?.(displayPreviewUrl(file, 'full'))} />
        <button data-point onClick={() => onImagePoint?.(0.5, 0.5)} />
        <button
          data-drag
          onClick={() => onImageRegion?.({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })}
        />
      </div>
    )
  }
})
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
  ColorScope: ({
    url,
    compact,
    region,
    pending
  }: {
    url?: string
    compact?: boolean
    region?: PreviewRegion | null
    pending?: boolean
  }) => (
    <div
      data-scope
      data-scope-url={url}
      data-compact={compact}
      data-scope-region={region ? JSON.stringify(region) : undefined}
      data-pending={pending}
    />
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
      picking,
      setPicking,
      onNavigate
    }: {
      picking: boolean
      setPicking: (value: boolean) => void
      onNavigate: (page: 'emulsion' | 'paper') => void
    }) {
      return (
        <>
          <button
            data-cloud={useContext(DevelopingCloud)}
            aria-pressed={picking}
            onClick={() => setPicking(true)}
          >
            Pick white balance
          </button>
          <button data-sidebar-page="emulsion" onClick={() => onNavigate('emulsion')}>
            Choose emulsion
          </button>
          <button data-sidebar-page="paper" onClick={() => onNavigate('paper')}>
            Choose paper
          </button>
          <details open>
            <summary>Mock section</summary>
            <button>Mock field</button>
            <details open>
              <summary>Mock nested section</summary>
              <button>Mock nested field</button>
            </details>
          </details>
        </>
      )
    }
  }
})
vi.mock('../src/renderer/src/components/BatchProgress', () => ({ BatchProgress: () => null }))
vi.mock('../src/renderer/src/components/ScopeMenu', () => ({
  ScopeMenu: () => <button data-scope-menu>Scope view</button>
}))
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
  vi.restoreAllMocks()
  real.preview = false
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
    const apply = screen.getByRole('button', { name: t('editor.crop') })
    apply.focus()
    fireEvent.click(apply)
    // The crop toolbar stays, inert, until its exit ends.
    expect(screen.queryByRole('button', { name: t('editor.done') })).toBeNull()
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

it('gives focus to the overflow menu button when Crop is folded', () => {
  // The toolbar is 500 px wide and every button 100 px, so Crop folds into the menu.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.tagName === 'BUTTON' ? 100 : this.querySelectorAll('button').length * 100
  })
  try {
    editor.setState({
      session: { ...session, asShotCrop: null },
      documents: { [file.path]: doc },
      preview: frame,
      loading: false
    })
    render(<EditorScreen />)
    expect(screen.queryByRole('button', { name: t('editor.crop') })).toBeNull()
    // The menu takes the place of the folded buttons, before the buttons that still show.
    const more = screen.getByRole('button', { name: t('toolbar.more') })
    const done = screen.getByRole('button', { name: t('editor.done') })
    expect(more.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    act(() => editor.setState({ cropping: true }))
    act(() => editor.setState({ cropping: false }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('toolbar.more') }))
  } finally {
    vi.restoreAllMocks()
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
  expect(
    (screen.getByRole('button', { name: t('editor.crop') }) as HTMLButtonElement).disabled
  ).toBe(true)
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
  for (const name of [...normal, t('editor.done')])
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
  fireEvent.click(screen.getByRole('button', { name: t('editor.crop') }))
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

function scopeAttribute(name: string): string | null | undefined {
  return document.querySelector('[data-scope]')?.getAttribute(name)
}
function previewAttribute(name: string): string | null | undefined {
  return document.querySelector('[data-editor-frame]')?.getAttribute(name)
}
const selectedScope = (): string | null =>
  screen.getByRole('tab', { selected: true }).getAttribute('id')
const renderKey = (value = recipe): string => `${session.sessionId}:${JSON.stringify(value)}`

it('measures the entire image or the visible area, and waits for current pixels while zoomed', () => {
  editor.setState({
    session,
    documents: { [file.path]: doc },
    loading: false,
    preview: frame,
    previewKey: renderKey()
  })
  const view = render(<EditorScreen />)
  // The scope view menu leads the scope row, and icon tabs choose the area. The header
  // has no menu.
  const tablist = screen.getByRole('tablist', { name: 'Scope area' })
  const tabs = within(tablist).getAllByRole('tab')
  expect(tablist.parentElement!.parentElement!.firstElementChild).toBe(
    screen.getByText('Scope view')
  )
  expect(view.container.querySelectorAll('[data-scope-menu]')).toHaveLength(1)
  expect(tabs.map((tab) => [tab.getAttribute('aria-label'), tab.getAttribute('title')])).toEqual([
    ['Entire image', 'Entire image'],
    ['Visible area', 'Visible area']
  ])
  // The Qualifier is a toggle button beside the group.
  expect(screen.getByRole('button', { name: 'Qualifier' }).getAttribute('aria-pressed')).toBe(
    'false'
  )
  expect(selectedScope()).toBe('scope-tab-entire')
  expect(scopeAttribute('data-scope-url')).toBe(frame.url)
  expect(scopeAttribute('data-pending')).toBe('false')
  // Entire image keeps the whole-image preview while zoomed.
  const region = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
  const tile = {
    ...frame,
    url: 'x3f-edit://localhost/tile-a',
    draft: false,
    region,
    viewport: region
  }
  act(() => editor.setState({ viewport: region, tile }))
  expect(scopeAttribute('data-scope-url')).toBe(frame.url)
  expect(scopeAttribute('data-pending')).toBe('false')
  // An exposure change while zoomed renders the tile first. The scope gets no stale
  // pixels and keeps its last paint as pending until prefetch refreshes the preview.
  const brighter = { ...recipe, exposure: 1 }
  act(() =>
    editor.setState({
      documents: { [file.path]: { ...doc, recipe: brighter } },
      tile: { ...tile, revision: 2, url: 'x3f-edit://localhost/tile-b' }
    })
  )
  expect(scopeAttribute('data-scope-url')).toBeNull()
  expect(scopeAttribute('data-pending')).toBe('true')
  // Also for a new qualified area: it waits for the current preview.
  fireEvent.click(screen.getByRole('button', { name: 'Qualifier' }))
  expect(scopeAttribute('data-scope-url')).toBeNull()
  expect(scopeAttribute('data-pending')).toBe('true')
  fireEvent.click(tabs[0])
  const refreshed = { ...frame, revision: 2, url: 'x3f-edit://localhost/live-b' }
  act(() => editor.setState({ preview: refreshed, previewKey: renderKey(brighter) }))
  expect(scopeAttribute('data-scope-url')).toBe(refreshed.url)
  expect(scopeAttribute('data-pending')).toBe('false')

  fireEvent.click(tabs[1])
  expect(selectedScope()).toBe('scope-tab-visible')
  expect(scopeAttribute('data-scope-url')).toBe('x3f-edit://localhost/tile-b')
  expect(scopeAttribute('data-pending')).toBe('false')
  // A pan keeps the old tile on screen, but the scope does not measure it.
  const next = { ...region, x: 0.3 }
  act(() => editor.setState({ viewport: next }))
  expect(scopeAttribute('data-scope-url')).toBeNull()
  expect(scopeAttribute('data-pending')).toBe('true')
  const panned = { ...tile, url: 'x3f-edit://localhost/tile-c', region: next, viewport: next }
  act(() => editor.setState({ tile: panned }))
  expect(scopeAttribute('data-scope-url')).toBe(panned.url)
  expect(scopeAttribute('data-pending')).toBe('false')
  // At Fit, the visible area is the whole-image preview.
  act(() => editor.setState({ viewport: null, tile: null }))
  expect(scopeAttribute('data-scope-url')).toBe(refreshed.url)
  expect(scopeAttribute('data-pending')).toBe('false')
})

it('qualifies a point or a dragged area, apart from the white balance picker', () => {
  const close = vi.fn(async () => true)
  editor.setState({
    session,
    documents: { [file.path]: doc },
    loading: false,
    preview: frame,
    previewGeometry: geometryKey(recipe),
    close
  })
  const view = render(<EditorScreen />)
  fireEvent.click(view.container.querySelector('[data-paint]')!)
  const [entire] = within(screen.getByRole('tablist', { name: 'Scope area' })).getAllByRole('tab')
  const qualifier = screen.getByRole('button', { name: 'Qualifier' })
  const picker = (): HTMLElement => screen.getByRole('button', { name: 'Pick white balance' })
  const qualifying = (): string | null | undefined => previewAttribute('data-qualifying')
  const region = (): unknown => JSON.parse(scopeAttribute('data-scope-region') ?? 'null')
  const outline = (): unknown => JSON.parse(previewAttribute('data-outline') ?? 'null')
  const hint = (): HTMLElement | null => screen.queryByText(t('editor.scopeQualifyHint'))

  // The arrow keys move between the tabs. The Qualifier arms the photo and disarms the picker.
  fireEvent.click(picker())
  expect(picker().getAttribute('aria-pressed')).toBe('true')
  expect(qualifying()).toBe('false')
  fireEvent.click(qualifier)
  expect(qualifier.getAttribute('aria-pressed')).toBe('true')
  expect(
    within(screen.getByRole('tablist', { name: 'Scope area' })).queryAllByRole('tab', {
      selected: true
    })
  ).toHaveLength(0)
  expect(qualifying()).toBe('true')
  expect(picker().getAttribute('aria-pressed')).toBe('false')
  expect(hint()?.getAttribute('role')).toBe('status')
  // Without an area, the Qualifier measures the entire image.
  expect(scopeAttribute('data-scope-url')).toBe(frame.url)
  expect(region()).toBeNull()
  // The picker, from its button or from W, disarms the Qualifier. The hint shows the armed state.
  fireEvent.click(picker())
  expect(qualifying()).toBe('false')
  expect(hint()).toBeNull()
  // A click on the selected Qualifier arms it again.
  expect(qualifier.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(qualifier)
  expect(qualifying()).toBe('true')
  expect(hint()).not.toBeNull()
  expect(picker().getAttribute('aria-pressed')).toBe('false')
  fireEvent.keyDown(document, { key: 'w' })
  expect(picker().getAttribute('aria-pressed')).toBe('true')
  expect(qualifying()).toBe('false')

  // A point measures a square of 2 percent of the long edge, in pixels, centered on it.
  fireEvent.click(qualifier)
  fireEvent.click(view.container.querySelector('[data-point]')!)
  expect(qualifying()).toBe('false')
  const point = region() as PreviewRegion
  const height = (1024 * 0.02) / 683
  expect(point.x).toBeCloseTo(0.49)
  expect(point.width).toBeCloseTo(0.02)
  expect(point.y).toBeCloseTo(0.5 - height / 2)
  expect(point.height).toBeCloseTo(height)
  expect(outline()).toEqual(point)

  // Escape disarms the Qualifier before it closes the editor, and keeps the area.
  fireEvent.click(qualifier)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(qualifying()).toBe('false')
  expect(close).not.toHaveBeenCalled()
  expect(region()).toEqual(point)
  // A drag measures its rectangle.
  const drawn = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
  fireEvent.click(qualifier)
  fireEvent.click(view.container.querySelector('[data-drag]')!)
  expect(region()).toEqual(drawn)
  expect(outline()).toEqual(drawn)

  // A geometry change clears the area. A new frame shows only after it decodes, so until
  // the frame of the new geometry paints, even after its render arrives, a selection on
  // the photo is ignored and the Qualifier stays armed.
  const rotated = { ...recipe, rotation: 1 }
  const paint = (): boolean => fireEvent.click(view.container.querySelector('[data-paint]')!)
  const drag = (): boolean => fireEvent.click(view.container.querySelector('[data-drag]')!)
  const change = (value: typeof recipe): void =>
    act(() => editor.setState({ documents: { [file.path]: { ...doc, recipe: value } } }))
  const rendered = (value: typeof recipe, url: string): void =>
    act(() => editor.setState({ preview: { ...frame, url }, previewGeometry: geometryKey(value) }))
  change(rotated)
  expect(region()).toBeNull()
  expect(outline()).toBeNull()
  fireEvent.click(qualifier)
  drag()
  expect(region()).toBeNull()
  rendered(rotated, 'x3f-edit://localhost/portrait')
  drag()
  expect(region()).toBeNull()
  expect(qualifying()).toBe('true')
  paint()
  drag()
  expect(region()).toEqual(drawn)
  // An undo: the portrait frame stays on screen until the landscape frame decodes.
  change(recipe)
  rendered(recipe, 'x3f-edit://localhost/landscape')
  expect(region()).toBeNull()
  fireEvent.click(qualifier)
  fireEvent.click(view.container.querySelector('[data-point]')!)
  drag()
  expect(region()).toBeNull()
  expect(qualifying()).toBe('true')
  paint()
  drag()
  expect(region()).toEqual(drawn)
  // Leaving the tab clears the area.
  fireEvent.click(qualifier)
  fireEvent.click(view.container.querySelector('[data-drag]')!)
  expect(region()).toEqual(drawn)
  fireEvent.click(entire)
  expect(region()).toBeNull()
  fireEvent.click(qualifier)
  expect(region()).toBeNull()
  // Another photo clears the area and disarms the Qualifier.
  fireEvent.click(view.container.querySelector('[data-drag]')!)
  expect(region()).toEqual(drawn)
  fireEvent.click(qualifier)
  const other = { ...session, sessionId: 'session-b' }
  act(() => editor.setState({ session: other, preview: { ...frame, sessionId: 'session-b' } }))
  expect(region()).toBeNull()
  expect(qualifying()).toBe('false')
})

it('keeps a qualified point square through an undo and a redo before the frames paint', () => {
  const rotated = { ...recipe, rotation: 1 }
  const portrait = { ...frame, url: 'x3f-edit://localhost/portrait', width: 683, height: 1024 }
  editor.setState({
    session,
    documents: { [file.path]: { ...doc, recipe: rotated } },
    loading: false,
    preview: portrait,
    previewGeometry: geometryKey(rotated)
  })
  const view = render(<EditorScreen />)
  const point = (): boolean => fireEvent.click(view.container.querySelector('[data-point]')!)
  const change = (value: typeof recipe): void =>
    act(() => editor.setState({ documents: { [file.path]: { ...doc, recipe: value } } }))
  const rendered = (value: typeof recipe, preview: typeof frame): void =>
    act(() => editor.setState({ preview, previewGeometry: geometryKey(value) }))
  const region = (): unknown => JSON.parse(scopeAttribute('data-scope-region') ?? 'null')
  fireEvent.click(view.container.querySelector('[data-paint]')!)
  fireEvent.click(screen.getByRole('button', { name: 'Qualifier' }))
  // An undo: the landscape render arrives, but its frame does not paint yet.
  change(recipe)
  rendered(recipe, { ...frame, url: 'x3f-edit://localhost/landscape' })
  // A redo before the landscape frame paints: the portrait frame on screen matches the
  // geometry again, but the latest render, which gives a point its size, is landscape.
  change(rotated)
  point()
  expect(region()).toBeNull()
  expect(screen.queryByText(t('editor.scopeQualifyHint'))).not.toBeNull()
  // The portrait render arrives: a point is a square in its pixels.
  rendered(rotated, { ...portrait, url: 'x3f-edit://localhost/portrait-2' })
  point()
  const square = region() as PreviewRegion
  expect(square.width * 683).toBeCloseTo(0.02 * 1024)
  expect(square.height * 1024).toBeCloseTo(0.02 * 1024)
})

it('drops a drag that began on a frame of other geometry when the next frame paints', () => {
  // The real preview and image, with frames that decode when the test says so.
  real.preview = true
  const decoding = new Map<string, (preview: Decoded) => void>()
  real.decode.mockImplementation((url, ready) => {
    decoding.set(url, ready)
    return () => {}
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn()
  } as unknown as CanvasRenderingContext2D)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        if (target.getAttribute('aria-label') !== 'Image preview') return
        const entry = { target, contentRect: { width: 800, height: 600 } } as ResizeObserverEntry
        this.callback([entry], this as unknown as ResizeObserver)
      }
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId = 1
      isPrimary = true
    }
  )
  const rotated = { ...recipe, rotation: 1 }
  const portrait = { ...frame, url: 'x3f-edit://localhost/portrait' }
  const landscape = { ...frame, url: 'x3f-edit://localhost/landscape' }
  editor.setState({
    session,
    documents: { [file.path]: { ...doc, recipe: rotated } },
    loading: false,
    preview: portrait,
    previewGeometry: geometryKey(rotated)
  })
  const view = render(<EditorScreen />)
  const tall = { width: 683, height: 1024 }
  act(() => decoding.get(portrait.url)!({ image: tall, ...tall }))
  const surface = screen.getByRole('region', { name: 'Image preview' })
  const media = view.container.querySelector<HTMLElement>('.preview-image')!
  media.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect
  surface.setPointerCapture = vi.fn()
  surface.hasPointerCapture = () => true
  surface.releasePointerCapture = vi.fn()
  const band = (): Element | null => view.container.querySelector('[data-region-outline]')
  const region = (): unknown => JSON.parse(scopeAttribute('data-scope-region') ?? 'null')
  const drag = (): void => {
    fireEvent.pointerDown(surface, { button: 0, clientX: 80, clientY: 60 })
    fireEvent.pointerMove(surface, { clientX: 400, clientY: 300 })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Qualifier' }))

  // An undone rotation renders. Its landscape frame still decodes, so the portrait
  // frame stays on screen, and a drag begins on it.
  act(() =>
    editor.setState({
      documents: { [file.path]: doc },
      preview: landscape,
      previewGeometry: geometryKey(recipe)
    })
  )
  drag()
  expect(band()).not.toBeNull()
  // The landscape frame paints before the release: the drag ends without an area.
  const wide = { width: 1024, height: 683 }
  act(() => decoding.get(landscape.url)!({ image: wide, ...wide }))
  expect(band()).toBeNull()
  fireEvent.pointerUp(surface)
  fireEvent.click(surface, { clientX: 400, clientY: 300 })
  expect(region()).toBeNull()
  // The Qualifier stays armed.
  expect(screen.queryByText(t('editor.scopeQualifyHint'))).not.toBeNull()
  // A drag on the landscape frame measures its area.
  drag()
  fireEvent.pointerUp(surface)
  expect(region()).toEqual({
    x: expect.closeTo(0.1),
    y: expect.closeTo(0.1),
    width: expect.closeTo(0.4),
    height: expect.closeTo(0.4)
  })
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
  // A click on the tiny scope scrolls the sidebar back to the full scope, without motion
  // when reduced motion is on. The focus moves to the scope area.
  const scrollTo = vi.fn()
  HTMLElement.prototype.scrollTo = scrollTo
  const show = screen.getByRole('button', { name: t('editor.showScope') })
  expect(show.getAttribute('title')).toBe(t('editor.showScope'))
  expect(show.querySelector('[data-compact="true"]')).not.toBeNull()
  fireEvent.click(show)
  expect(scrollTo.mock.contexts[0]).toBe(show.closest('aside')!.querySelector('.overflow-y-auto'))
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' })
  expect(document.activeElement?.id).toBe('scope-tab-entire')
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  fireEvent.click(show)
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' })
  act(() => report([{ isIntersecting: true }]))
  expect(view.container.querySelector('[data-compact="true"]')).toBeNull()
  vi.unstubAllGlobals()
})

it('scrolls a keyboard focus out from under the stuck section headers', () => {
  editor.setState({ session, documents: { [file.path]: doc }, loading: false, preview: frame })
  render(<EditorScreen />)
  const field = screen.getByRole('button', { name: 'Mock field' })
  const body = field.closest<HTMLElement>('.overflow-y-auto')!
  const place = (element: Element, top: number): void => {
    element.getBoundingClientRect = () => ({ top }) as DOMRect
  }
  // As Shift+Tab: a key down, then the focus.
  const tab = (element: HTMLElement, top: number): void => {
    place(element, top)
    fireEvent.keyDown(body, { key: 'Tab', shiftKey: true })
    act(() => element.focus())
    act(() => element.blur())
  }
  place(body, 100)
  body.scrollTop = 500
  // Each section around the focus has a stuck header of 40 px.
  tab(field, 130)
  expect(body.scrollTop).toBe(490)
  tab(screen.getByRole('button', { name: 'Mock nested field' }), 130)
  expect(body.scrollTop).toBe(440)
  // A nested header goes below the header of its parent only. A top-level header is never under one.
  tab(screen.getByText('Mock nested section'), 120)
  expect(body.scrollTop).toBe(420)
  tab(screen.getByText('Mock section'), 100)
  expect(body.scrollTop).toBe(420)
  // A field below the headers stays, and so does a control out of the sections.
  tab(field, 140)
  tab(screen.getByRole('tab', { name: 'Entire image' }), 0)
  expect(body.scrollTop).toBe(420)
  // A click focus does not scroll, so a click or a drag does not jump.
  place(field, 130)
  fireEvent.pointerDown(field)
  act(() => field.focus())
  expect(body.scrollTop).toBe(420)
})

function openPaper(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Choose paper' }))
}

it('returns from the stock pages with focus and scroll restored', () => {
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
  expect(screen.getByRole('button', { name: t('editor.cameraMatching') })).toBeTruthy()
  const back = screen.getByRole('button', { name: t('editor.backToAdjustments') })
  expect(document.activeElement).toBe(back)
  expect(back.closest('.overflow-y-auto')).toBeNull()
  expect(body.scrollTop).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: t('editor.backToAdjustments') }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose emulsion' }))
  expect(body.scrollTop).toBe(120)
  body.scrollTop = 64
  const paper = screen.getByRole('button', { name: 'Choose paper' })
  fireEvent.click(paper)
  expect(screen.getByRole('heading', { name: t('editor.paperStock') })).toBeTruthy()
  expect(body.scrollTop).toBe(0)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Pick white balance' })).toBeTruthy()
  expect(document.activeElement).toBe(paper)
  expect(body.scrollTop).toBe(64)
  fireEvent.click(paper)
  fireEvent.click(screen.getByRole('button', { name: t('editor.backToAdjustments') }))
  expect(document.activeElement).toBe(paper)
  fireEvent.click(screen.getByRole('button', { name: 'Choose emulsion' }))
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
  expect(screen.queryByRole('button', { name: t('editor.backToAdjustments') })).toBeNull()
})

it('keeps an X3I zoomable and its SFD RAW toggle usable while it merges, and morphs between RAWs', () => {
  const sfd = { ...doc, recipe: { ...recipe, x3iSource: 'merge' as const } }
  editor.setState({
    session,
    documents: { [file.path]: sfd },
    loading: false,
    preview: null,
    x3i: { frames: 7, processed: false },
    renderThumbnail: vi.fn(async () => null)
  })
  const view = render(<EditorScreen />)
  const controls = (): HTMLElement => screen.getByRole('button', { name: 'Choose emulsion' })
  const clouds = (): NodeListOf<Element> =>
    view.container.querySelectorAll('[data-placeholder], [data-condensing]')
  // Without a render, the embedded preview still zooms and pans. Its viewport stays
  // out of the store, so the first render after the merge is a full preview.
  const viewport = (): string | null | undefined =>
    view.container.querySelector('[data-editor-frame]')?.getAttribute('data-viewport')
  expect(viewport()).toBe('false')
  expect(clouds()).toHaveLength(0)
  // EditorControls keeps all but the SFD RAW section inert.
  expect(controls().matches(':disabled')).toBe(false)
  act(() => editor.setState({ x3i: { frames: 7, processed: true }, preview: frame }))
  expect(viewport()).toBe('true')
  // A change of RAW turns the preview into particles until the photo renders.
  act(() => editor.setState({ switching: true }))
  expect(clouds()).toHaveLength(1)
  act(() => editor.setState({ switching: false }))
  fireEvent.click(view.container.querySelector('[data-condensing]')!)
  expect(clouds()).toHaveLength(0)
  // Undo back to a merge leaves the Emulsion page and scrolls to the top.
  const body = view.container.querySelector('.overflow-y-auto') as HTMLElement
  body.scrollTop = 400
  fireEvent.click(controls())
  act(() => editor.setState({ x3i: { frames: 7, processed: false } }))
  expect(screen.queryByRole('button', { name: t('editor.backToAdjustments') })).toBeNull()
  expect(body.scrollTop).toBe(0)
})

it('returns to adjustments when undo removes the film from the paper page', () => {
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
  expect(screen.getByRole('button', { name: 'Pick white balance' })).toBeTruthy()
})
