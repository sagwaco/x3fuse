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

vi.mock('../src/renderer/src/components/FileFilmstrip', () => ({
  FileFilmstrip: ({ preview }: { preview: ReactNode }) => <main>{preview}</main>
}))
vi.mock('../src/renderer/src/components/OrientedImage', () => ({
  OrientedImage: ({ file }: { file: X3FFileDTO }) => (
    <img data-placeholder src={displayPreviewUrl(file)} alt={file.fileName} />
  )
}))
vi.mock('../src/renderer/src/components/ZoomablePreview', () => ({
  ZoomablePreview: ({ file, onImagePoint }: { file: X3FFileDTO; onImagePoint?: unknown }) => (
    <div data-editor-frame={displayPreviewUrl(file, 'full')} data-picking={!!onImagePoint} />
  )
}))
vi.mock('../src/renderer/src/components/CropPreview', () => ({
  CropPreview: () => <div data-crop-preview />
}))
vi.mock('../src/renderer/src/components/ColorScope', () => ({
  ColorScope: ({ url }: { url?: string }) => <div data-scope-url={url} />
}))
vi.mock('../src/renderer/src/components/EditorControls', () => ({
  EditorControls: ({ setPicking }: { setPicking: (value: boolean) => void }) => (
    <button onClick={() => setPicking(true)}>Pick white balance</button>
  )
}))
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
  act(() => editor.setState({ preview: { ...frame, draft: true }, rendering: false }))
  expect(view.container.querySelector('[data-placeholder]')).toBeNull()
  expect(
    view.container.querySelector('[data-editor-frame]')?.getAttribute('data-editor-frame')
  ).toBe(frame.url)
  expect(screen.getByText('Developing RAW preview…')).toBeTruthy()
  act(() => editor.setState({ error: 'Refinement failed' }))
  expect(screen.queryByText('Developing RAW preview…')).toBeNull()
  act(() => editor.setState({ error: null }))
  expect(screen.getByText('Developing RAW preview…')).toBeTruthy()
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
  expect(screen.queryByText('Developing RAW preview…')).toBeNull()
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

it('does not show saved pixels for a different recipe, unsaved gesture, or missing edited preview', () => {
  editor.setState({
    session,
    documents: { [file.path]: { ...doc, recipe: { ...recipe, exposure: 2 } } }
  })
  const view = render(<EditorScreen />)
  expect(screen.queryByRole('img')).toBeNull()
  act(() => editor.setState({ documents: { [file.path]: { ...doc, gesture: recipe } } }))
  expect(screen.queryByRole('img')).toBeNull()
  act(() => editor.setState({ documents: { [file.path]: { ...doc, dirty: true } } }))
  expect(screen.queryByRole('img')).toBeNull()
  act(() => editor.setState({ documents: { [file.path]: doc } }))
  expect(screen.getByRole('img').getAttribute('src')).toContain('saved-a?v=thumbnail')
  act(() =>
    queue.setState({ files: [{ ...file, edit: { ...file.edit!, previewUrl: undefined } }] })
  )
  expect(view.container.querySelector('[data-placeholder]')).toBeNull()
})
