// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NativeMenuRequest } from '@shared/ipc'
import { QueueContextMenu } from '../src/renderer/src/components/QueueContextMenu'
import { useQueueSelection } from '../src/renderer/src/hooks/useQueueSelection'
import { useQueueStore } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { useEditorStore } from '../src/renderer/src/stores/editorStore'
import { useNavStore } from '../src/renderer/src/stores/navStore'
import { t } from '../src/renderer/src/lib/strings'
import { defaultRecipe } from '@shared/editor'
import { DEFAULT_SETTINGS } from '@shared/types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))
const files = ['a', 'b'].map((id) => ({ id, path: `/photos/${id}.X3F`, fileName: `${id}.X3F` }))
let choose: (value: string | null) => void
const request = (): NativeMenuRequest =>
  invoke.mock.calls.filter(([channel]) => channel === 'menu:popup').at(-1)![1]

function Surface({ disabled = false }: { disabled?: boolean }) {
  const selection = useQueueSelection(files, { mode: 'vertical' })
  return (
    <QueueContextMenu disabled={disabled}>
      <div
        data-testid="surface"
        tabIndex={0}
        onContextMenu={selection.handleContainerContextMenu}
        onKeyDown={selection.handleKeyDown}
      >
        {files.map((file) => (
          <div key={file.id} onContextMenu={() => selection.handleItemContextMenu(file.id)}>
            {file.id}
          </div>
        ))}
      </div>
    </QueueContextMenu>
  )
}

beforeEach(() => {
  useQueueStore.setState({
    files,
    selectedIds: new Set(['a']),
    activeId: 'a',
    isProcessing: false,
    isPreparing: false,
    isCancelling: false,
    draft: null
  })
  invoke.mockImplementation(async (channel) =>
    channel === 'menu:popup'
      ? new Promise((resolve) => {
          choose = resolve
        })
      : undefined
  )
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('opens at the pointer after row selection and removes the clicked file', async () => {
  render(<Surface />)
  expect(fireEvent.contextMenu(screen.getByText('b'), { clientX: 120, clientY: 80 })).toBe(false)
  expect(request()).toMatchObject({
    x: 120,
    y: 80,
    items: [
      { value: 'edit', label: t('menu.file.edit_photo'), accelerator: 'D', disabled: false },
      { value: 'flag', separatorBefore: true },
      { value: 'rating' },
      { value: 'copy', accelerator: 'CmdOrCtrl+Shift+C', separatorBefore: true, disabled: true },
      { value: 'paste', accelerator: 'CmdOrCtrl+Shift+V', disabled: true },
      { value: 'export', label: t('context.convert'), separatorBefore: true, disabled: false },
      { value: 'reveal', accelerator: 'CmdOrCtrl+R', separatorBefore: true },
      { value: 'remove', disabled: false, separatorBefore: true },
      { value: 'deselect', accelerator: 'CmdOrCtrl+D' }
    ]
  })
  expect(request().items[0]).not.toHaveProperty('separatorBefore')
  const [flag, rating] = [1, 2].map((index) => request().items[index].items!)
  expect(flag.map((item) => item.accelerator)).toEqual(['Z', 'X', 'U'])
  expect(rating.map((item) => item.accelerator)).toEqual(['0', '1', '2', '3', '4', '5'])
  expect(request().items[5].items).toMatchObject([
    { value: 'export:screen', label: t('menu.file.export'), accelerator: 'CmdOrCtrl+Shift+E' },
    { value: 'export:previous', accelerator: 'CmdOrCtrl+Alt+Shift+E', disabled: true },
    { value: 'export:jpeg', separatorBefore: true },
    { value: 'export:embeddedJpg' },
    { value: 'export:dng' },
    { value: 'export:tiff' }
  ])
  expect(useQueueStore.getState().selectedIds).toEqual(new Set(['b']))
  expect(screen.queryByRole('menu')).toBeNull()
  await act(async () => choose('remove'))
  expect(useQueueStore.getState().files).toEqual([files[0]])
})

it('flags and rates the selection from submenus that show its current values', async () => {
  useQueueStore.setState({
    files: files.map((file) => ({ ...file, flag: 'reject' as const, rating: 2 })),
    selectedIds: new Set(['a', 'b'])
  })
  render(<Surface />)
  fireEvent.contextMenu(screen.getByText('b'))
  const [flag, rating] = ['flag', 'rating'].map(
    (value) => request().items.find((item) => item.value === value)!.items!
  )
  expect(flag.filter((item) => item.checked).map((item) => item.value)).toEqual(['flag:reject'])
  expect(rating.map((item) => item.checked)).toEqual([false, false, true, false, false, false])
  await act(async () => choose('flag:pick'))
  expect(useQueueStore.getState().files.map((file) => file.flag)).toEqual(['pick', 'pick'])
  fireEvent.contextMenu(screen.getByText('a'))
  await act(async () => choose('rating:5'))
  expect(useQueueStore.getState().files.map((file) => file.rating)).toEqual([5, 5])
})

it('flags the right-clicked photo in the filmstrip, even when another one was active', async () => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, queueViewMode: 'filmstrip' } })
  useQueueStore.setState({ selectedIds: new Set(['a', 'b']), activeId: 'a' })
  render(<Surface />)
  fireEvent.contextMenu(screen.getByText('b'))
  // A later selection change does not move the menu's target.
  act(() => useQueueStore.getState().setSelection(new Set(['a']), 'a'))
  await act(async () => choose('flag:reject'))
  expect(useQueueStore.getState().files.map((file) => file.flag)).toEqual([undefined, 'reject'])
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
})

it('preserves multi-selection, reveals its files, and offers all-file actions on empty space', async () => {
  useQueueStore.setState({ selectedIds: new Set(['a', 'b']) })
  render(<Surface />)
  fireEvent.contextMenu(screen.getByText('b'))
  await act(async () => choose('reveal'))
  for (const file of files) expect(invoke).toHaveBeenCalledWith('shell:reveal', { path: file.path })
  fireEvent.contextMenu(screen.getByTestId('surface'))
  expect(useQueueStore.getState().selectedIds.size).toBe(0)
  expect(request().items.map((item) => item.value)).toEqual(['export', 'remove'])
  await act(async () => choose('remove'))
  expect(useQueueStore.getState().files).toEqual([])
})

it('supports keyboard invocation, busy states, and invalidation when disabled or unmounted', async () => {
  useQueueStore.setState({ isProcessing: true })
  const view = render(<Surface />)
  const surface = screen.getByTestId('surface')
  fireEvent.keyDown(surface, { key: 'F10', shiftKey: true })
  expect(request().items.find((item) => item.value === 'stop')).toBeDefined()
  expect(request().items.find((item) => item.value === 'remove')?.disabled).toBe(true)
  await act(async () => choose('remove'))
  expect(useQueueStore.getState().files).toEqual(files)
  useQueueStore.setState({ isProcessing: false })
  fireEvent.keyDown(surface, { key: 'ContextMenu' })
  view.rerender(<Surface disabled />)
  await act(async () => choose('remove'))
  expect(useQueueStore.getState().files).toEqual(files)
  invoke.mockClear()
  fireEvent.contextMenu(surface)
  expect(invoke).not.toHaveBeenCalled()
  view.rerender(<Surface />)
  fireEvent.contextMenu(screen.getByText('b'))
  view.unmount()
  await act(async () => choose('remove'))
  expect(useQueueStore.getState().files).toEqual(files)
})

it('edits, copies, pastes, and exports the photos fixed when the menu opened', async () => {
  const edited = files.map((file, index) => ({
    ...file,
    edit: { recipe: { ...defaultRecipe(), exposure: index }, revision: 1 }
  }))
  const editor = useEditorStore.getState()
  const queue = useQueueStore.getState()
  const nav = useNavStore.getState()
  const paste = vi.fn(async () => {})
  const exportPreset = vi.fn(async () => {})
  invoke.mockImplementation(async (channel, payload) =>
    channel === 'menu:popup'
      ? new Promise((resolve) => {
          choose = resolve
        })
      : channel === 'editor:open'
        ? {
            sessionId: 'session',
            path: payload.path,
            recipe: defaultRecipe(),
            revision: 0,
            storage: 'none',
            sourceRevision: 'source'
          }
        : undefined
  )
  useEditorStore.setState({ paste, clipboard: defaultRecipe() })
  useQueueStore.setState({ files: edited, exportPreset })
  render(<Surface />)
  const menu = (): void => {
    act(() => useQueueStore.getState().setSelection(new Set(['a', 'b']), 'a'))
    fireEvent.contextMenu(screen.getByText('b'))
    // A later selection change does not move the menu's targets.
    act(() => useQueueStore.getState().setSelection(new Set(['a']), 'a'))
  }
  menu()
  expect(request().items.find((item) => item.value === 'copy')?.disabled).toBe(false)
  expect(request().items.find((item) => item.value === 'paste')?.disabled).toBe(false)
  await act(async () => choose('copy'))
  expect(useEditorStore.getState().clipboard).toEqual(edited[1].edit.recipe)
  menu()
  await act(async () => choose('paste'))
  expect(paste).toHaveBeenCalledWith(edited)
  menu()
  await act(async () => choose('export:tiff'))
  expect(exportPreset).toHaveBeenCalledWith('tiff', new Set(['a', 'b']))
  // The editor opens the photo of the menu, which is the active photo that it shows.
  menu()
  await act(async () => choose('edit'))
  expect(useEditorStore.getState().session?.path).toBe(edited[1].path)
  expect(useQueueStore.getState().activeId).toBe('b')
  useEditorStore.setState(editor, true)
  useQueueStore.setState({ exportPreset: queue.exportPreset })
  useNavStore.setState(nav, true)
})
