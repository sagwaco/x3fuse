// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import shortcuts from '@shared/shortcuts.json'
import { DEFAULT_SETTINGS, type QueueViewMode, type X3FFileDTO } from '@shared/types'
import { HELP_URL, registerCommands, runCommand } from '../src/renderer/src/lib/commands'
import { useShortcuts } from '../src/renderer/src/hooks/useShortcuts'
import { useQueueSelection } from '../src/renderer/src/hooks/useQueueSelection'
import { formatAccelerator, withShortcut } from '../src/renderer/src/lib/shortcut'
import { appInfo } from '../src/renderer/src/lib/appInfo'
import { NO_FILTER } from '../src/renderer/src/lib/culling'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { useNavStore } from '../src/renderer/src/stores/navStore'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { ShortcutSheet } from '../src/renderer/src/components/ShortcutSheet'
import { Slider } from '../src/renderer/src/components/ui/slider'

const opener = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path, invoke: opener }))

const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>()
;(window as unknown as { x3f: unknown }).x3f = { invoke, on: () => () => {} }

const files: X3FFileDTO[] = ['a', 'b', 'c'].map((id) => ({
  id,
  path: `/photos/${id}.X3F`,
  fileName: `${id}.X3F`
}))
const initialEditor = editor.getState()
const initialQueue = queue.getState()
const initialSettings = useSettingsStore.getState()
const update = vi.fn(async () => {})
const settle = (): Promise<void> => new Promise((done) => setTimeout(done))
const view = (queueViewMode: QueueViewMode): void =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, queueViewMode } })

function Keys(): null {
  useShortcuts()
  return null
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined)
  update.mockClear()
  queue.setState({ files, selectedIds: new Set(['a']), activeId: 'a', filter: NO_FILTER })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true, update })
  view('grid')
  useNavStore.setState({ screen: 'queue' })
  appInfo.platform = 'linux'
})
afterEach(async () => {
  cleanup()
  await settle()
  editor.setState(initialEditor, true)
  queue.setState(initialQueue, true)
  useSettingsStore.setState(initialSettings, true)
  useNavStore.setState({ screen: 'queue' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('runCommand', () => {
  it('edits the active or first selected photo, from the library only', () => {
    const open = vi.fn(async () => {})
    editor.setState({ open })
    queue.setState({ selectedIds: new Set(['b', 'c']), activeId: 'c' })
    expect(runCommand('editPhoto')).toBe(true)
    expect(open).toHaveBeenCalledWith(files[2])
    useNavStore.setState({ screen: 'editor' })
    expect(runCommand('editPhoto')).toBe(false)
  })

  it('exports the cull targets, and in the editor only the formats with the edit', () => {
    const openExport = vi.fn()
    const exportPreset = vi.fn(async () => {})
    queue.setState({ selectedIds: new Set(['a', 'b']), openExport, exportPreset })
    expect(runCommand('exportSelected')).toBe(true)
    expect(openExport).toHaveBeenCalledWith(new Set(['a', 'b']), 'queue')
    expect(runCommand('exportDng')).toBe(true)
    expect(exportPreset).toHaveBeenLastCalledWith('dng', new Set(['a', 'b']), 'queue')
    // Without previous settings, Export with Previous does not apply.
    expect(runCommand('exportPrevious')).toBe(false)
    useNavStore.setState({ screen: 'editor' })
    queue.setState({ activeId: 'b' })
    expect(runCommand('exportTiff')).toBe(true)
    expect(exportPreset).toHaveBeenLastCalledWith('tiff', new Set(['b']), 'editor')
    expect(runCommand('exportSelected')).toBe(true)
    expect(openExport).toHaveBeenLastCalledWith(new Set(['b']), 'editor')
    expect(runCommand('exportDng')).toBe(false)
    expect(runCommand('exportEmbeddedJpg')).toBe(false)
  })

  it('shows the selection in Finder, or the open photo in the editor', () => {
    const revealed = (): unknown[] =>
      invoke.mock.calls.filter(([channel]) => channel === 'shell:reveal').map(([, path]) => path)
    queue.setState({ selectedIds: new Set(['a', 'c']) })
    expect(runCommand('showInFinder')).toBe(true)
    expect(revealed()).toEqual([{ path: '/photos/a.X3F' }, { path: '/photos/c.X3F' }])
    invoke.mockClear()
    useNavStore.setState({ screen: 'editor' })
    editor.setState({ session: { path: '/photos/b.X3F' } as never })
    expect(runCommand('showInFinder')).toBe(true)
    expect(revealed()).toEqual([{ path: '/photos/b.X3F' }])
    useNavStore.setState({ screen: 'queue' })
    queue.setState({ selectedIds: new Set() })
    expect(runCommand('showInFinder')).toBe(false)
  })

  it('changes the selection, view, sort, filter bar, and panel on their screens', () => {
    expect(runCommand('invertSelection')).toBe(true)
    expect(queue.getState().selectedIds).toEqual(new Set(['b', 'c']))
    expect(runCommand('viewSurvey')).toBe(true)
    expect(update).toHaveBeenLastCalledWith({ queueViewMode: 'survey' })
    expect(runCommand('sortByDate')).toBe(true)
    expect(update).toHaveBeenLastCalledWith({ sortField: 'Date' })
    expect(runCommand('sortDescending')).toBe(true)
    expect(update).toHaveBeenLastCalledWith({ sortAscending: false })
    expect(runCommand('toggleFilterBar')).toBe(true)
    expect(queue.getState().filterOpen).toBe(true)
    expect(runCommand('togglePanel')).toBe(true)
    expect(update).toHaveBeenLastCalledWith({ inspectorOpen: !DEFAULT_SETTINGS.inspectorOpen })
    useNavStore.setState({ screen: 'editor' })
    for (const name of ['invertSelection', 'viewGrid', 'toggleFilterBar'] as const)
      expect(runCommand(name)).toBe(false)
    expect(runCommand('togglePanel')).toBe(true)
    expect(update).toHaveBeenLastCalledWith({
      editorPanelOpen: !DEFAULT_SETTINGS.editorPanelOpen
    })
    useNavStore.setState({ screen: 'export' })
    expect(runCommand('togglePanel')).toBe(false)
  })

  it('steps through the shown photos in the filmstrip and the editor', () => {
    expect(runCommand('nextPhoto')).toBe(false)
    view('filmstrip')
    expect(runCommand('nextPhoto')).toBe(true)
    expect(queue.getState().activeId).toBe('b')
    expect(queue.getState().selectedIds).toEqual(new Set(['b']))
    runCommand('previousPhoto')
    expect(runCommand('previousPhoto')).toBe(true)
    expect(queue.getState().activeId).toBe('a')
    useNavStore.setState({ screen: 'editor' })
    editor.setState({ cropping: true })
    expect(runCommand('nextPhoto')).toBe(false)
    editor.setState({ cropping: false })
    expect(runCommand('nextPhoto')).toBe(true)
    expect(queue.getState().activeId).toBe('b')
  })

  it('moves each rating one star, from 0 to 5', async () => {
    queue.setState({
      files: files.map((file, index) => ({ ...file, rating: [0, 4, 5][index] })),
      selectedIds: new Set(['a', 'b', 'c'])
    })
    expect(runCommand('ratingUp')).toBe(true)
    expect(queue.getState().files.map((file) => file.rating)).toEqual([1, 5, 5])
    await settle()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'culling:set')).toEqual([
      ['culling:set', { paths: ['/photos/a.X3F'], rating: 1 }],
      ['culling:set', { paths: ['/photos/b.X3F', '/photos/c.X3F'], rating: 5 }]
    ])
    runCommand('ratingDown')
    runCommand('ratingDown')
    expect(queue.getState().files.map((file) => file.rating)).toEqual([0, 3, 3])
    queue.setState({ selectedIds: new Set(), activeId: null })
    expect(runCommand('ratingUp')).toBe(false)
  })

  it('opens Help in the browser', () => {
    expect(runCommand('help')).toBe(true)
    expect(opener).toHaveBeenCalledWith('plugin:opener|open_url', { url: HELP_URL })
  })

  it('does the text action from the menu in a text field, and waits for an open dialog', () => {
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    const undo = vi.fn()
    const copy = vi.fn()
    editor.setState({ undo, copy })
    useNavStore.setState({ screen: 'editor' })
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    expect(runCommand('undoEdit', { source: 'menu' })).toBe(true)
    expect(runCommand('selectAll', { source: 'menu' })).toBe(true)
    expect(execCommand.mock.calls).toEqual([['undo'], ['selectAll']])
    // A key leaves the field its own undo. Other commands run as usual.
    expect(runCommand('undoEdit', { source: 'key' })).toBe(false)
    expect(undo).not.toHaveBeenCalled()
    expect(runCommand('copyEdits', { source: 'menu' })).toBe(true)
    expect(copy).toHaveBeenCalled()
    input.remove()
    expect(runCommand('undoEdit', { source: 'menu' })).toBe(true)
    expect(undo).toHaveBeenCalledOnce()
    // A modal dialog takes the keys and the menu bar.
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    dialog.dataset.state = 'open'
    expect(runCommand('undoEdit', { source: 'menu' })).toBe(false)
    dialog.remove()
  })
})

describe('useShortcuts', () => {
  beforeEach(() => {
    render(<Keys />)
  })

  it('matches the platform key, the character, Alt by the physical key, and keypad digits', () => {
    const copy = vi.fn()
    editor.setState({ copy })
    fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true })
    expect(copy).toHaveBeenCalledTimes(1)
    appInfo.platform = 'darwin'
    fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true })
    expect(copy).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'c', metaKey: true })
    expect(copy).toHaveBeenCalledTimes(2)
    // Option changes the character on macOS, so ⌥⌘I matches its physical key.
    fireEvent.keyDown(document.body, { key: 'ˆ', code: 'KeyI', metaKey: true, altKey: true })
    expect(update).toHaveBeenLastCalledWith({ inspectorOpen: !DEFAULT_SETTINGS.inspectorOpen })
    // Letters follow the layout, as the menus do: on QWERTZ, the key that types Z is KeyY.
    fireEvent.keyDown(document.body, { key: 'z', code: 'KeyY' })
    expect(queue.getState().files[0].flag).toBe('pick')
    // Keypad digits rate as the digits of the main row do.
    fireEvent.keyDown(document.body, { key: '3', code: 'Numpad3' })
    expect(queue.getState().files[0].rating).toBe(3)
  })

  it('leaves keys to text fields, dialogs, input methods, and controls that used them', () => {
    const input = document.body.appendChild(document.createElement('input'))
    fireEvent.keyDown(input, { key: 'g' })
    fireEvent.keyDown(document.body, { key: 'g', isComposing: true })
    const button = document.body.appendChild(document.createElement('button'))
    button.addEventListener('keydown', (event) => event.preventDefault())
    fireEvent.keyDown(button, { key: 'g' })
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    dialog.dataset.state = 'open'
    fireEvent.keyDown(document.body, { key: 'g' })
    expect(update).not.toHaveBeenCalled()
    for (const element of [input, button, dialog]) element.remove()
    fireEvent.keyDown(document.body, { key: 'g' })
    expect(update).toHaveBeenCalledWith({ queueViewMode: 'grid' })
  })

  it('stops held keys from running, except zoom and photo steps', () => {
    const zoomIn = vi.fn(() => true)
    const off = registerCommands({ zoomIn })
    // A held key also must not reach a menu item, so it is prevented.
    expect(fireEvent.keyDown(document.body, { key: 'g', repeat: true })).toBe(false)
    expect(update).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: '=', ctrlKey: true, repeat: true })
    expect(zoomIn).toHaveBeenCalledOnce()
    off()
    // A key whose command does not apply keeps its default action.
    expect(fireEvent.keyDown(document.body, { key: '=', ctrlKey: true })).toBe(true)
  })

  it('gives the backslash to the filter bar in the library and to Compare in the editor', () => {
    fireEvent.keyDown(document.body, { key: '\\' })
    expect(queue.getState().filterOpen).toBe(true)
    useNavStore.setState({ screen: 'editor' })
    const compare = vi.fn(() => true)
    const off = registerCommands({ compare })
    fireEvent.keyDown(document.body, { key: '\\' })
    expect(compare).toHaveBeenCalledOnce()
    expect(queue.getState().filterOpen).toBe(true)
    off()
  })

  it('edits with Return only from the page, the list, or the grid', () => {
    const open = vi.fn(async () => {})
    editor.setState({ open })
    function List({ mode }: { mode: 'vertical' | 'horizontal' }): React.JSX.Element {
      const selection = useQueueSelection(files, { mode })
      return (
        <div tabIndex={0} data-testid={mode} onKeyDown={selection.handleKeyDown}>
          <button>{mode}</button>
        </div>
      )
    }
    render(
      <>
        <List mode="vertical" />
        <List mode="horizontal" />
      </>
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'vertical' }), { key: 'Enter' })
    fireEvent.keyDown(screen.getByTestId('horizontal'), { key: 'Enter' })
    expect(open).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId('vertical'), { key: 'Enter' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(open).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledWith(files[0])
  })

  it('steps photos with Control-arrow before a focused slider takes the arrow', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    const change = vi.fn()
    render(<Slider value={0} min={-10} max={10} onValueChange={change} aria-label="Exposure" />)
    const thumb = screen.getByRole('slider')
    view('filmstrip')
    fireEvent.keyDown(thumb, { key: 'ArrowRight', ctrlKey: true })
    expect(queue.getState().activeId).toBe('b')
    // In the grid, Next Photo does not apply, and the slider ignores the shortcut too.
    view('grid')
    fireEvent.keyDown(thumb, { key: 'ArrowRight', ctrlKey: true })
    expect(queue.getState().activeId).toBe('b')
    expect(change).not.toHaveBeenCalled()
    fireEvent.keyDown(thumb, { key: 'ArrowRight' })
    expect(change).toHaveBeenCalledWith(1)
  })
})

it('formats the keys for the platform', () => {
  appInfo.platform = 'darwin'
  expect(formatAccelerator('CmdOrCtrl+Alt+Shift+E')).toBe('⌥⇧⌘E')
  expect(formatAccelerator('CmdOrCtrl+BracketLeft')).toBe('⌘[')
  expect(formatAccelerator('Enter')).toBe('↩')
  expect(withShortcut('Undo', 'undoEdit')).toBe('Undo (⌘Z)')
  appInfo.platform = 'linux'
  expect(formatAccelerator('CmdOrCtrl+Shift+E')).toBe('Ctrl+Shift+E')
  expect(formatAccelerator('CmdOrCtrl+ArrowRight')).toBe('Ctrl+→')
  expect(withShortcut('Filter', 'toggleFilterBar')).toBe('Filter (\\)')
  expect(withShortcut('List view', 'viewList')).toBe('List view')
})

it('lists every command with a key in the shortcut sheet, which Escape closes', () => {
  render(<ShortcutSheet />)
  act(() => void runCommand('shortcuts'))
  const dialog = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' })
  const listed = [...dialog.querySelectorAll('[data-command]')].map((row) =>
    row.getAttribute('data-command')
  )
  expect(listed.sort()).toEqual(Object.keys(shortcuts).sort())
  const keys = (name: string): (string | null)[] =>
    [...dialog.querySelectorAll(`[data-command="${name}"] kbd`)].map((key) => key.textContent)
  expect(keys('pick')).toEqual(['Z', 'P'])
  expect(keys('copyEdits')).toEqual(['Ctrl+Shift+C', 'Ctrl+C'])
  // Every label has a translation.
  expect(dialog.textContent).not.toMatch(/(shortcuts|editor|cull|view)\.\w/)
  // The sheet takes the keys while it is open.
  expect(runCommand('selectAll')).toBe(false)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})
