import { invoke } from '@tauri-apps/api/core'
import type { CommandOptions, MenuCommand } from '@shared/ipc'
import type { ConversionSettings, QueueViewMode } from '@shared/types'
import { ipc } from './ipc'
import { appInfo } from './appInfo'
import { addFilesViaDialog, addFolderViaDialog } from './addFilesViaDialog'
import { shownFiles, useQueueStore } from '../stores/queueStore'
import { useEditorStore, isTextEditing } from '../stores/editorStore'
import { useNavStore } from '../stores/navStore'
import { useSettingsStore } from '../stores/settingsStore'
import { cull, cullTargets, stepRating } from '../hooks/useCulling'
import { exportWith } from '../hooks/useExportMenu'

export const HELP_URL = 'https://github.com/sagwaco/x3fuse#readme'

const VIEWS: Partial<Record<MenuCommand, QueueViewMode>> = {
  viewList: 'list',
  viewGrid: 'grid',
  viewFilmstrip: 'filmstrip',
  viewSurvey: 'survey'
}
const SORTS: Partial<Record<MenuCommand, Partial<ConversionSettings>>> = {
  sortByName: { sortField: 'File Name' },
  sortByDate: { sortField: 'Date' },
  sortBySize: { sortField: 'Size' },
  sortAscending: { sortAscending: true },
  sortDescending: { sortAscending: false }
}
/** The `exportWith` values of the export commands. */
const EXPORTS: Partial<Record<MenuCommand, string>> = {
  exportPrevious: 'previous',
  exportJpeg: 'jpeg',
  exportTiff: 'tiff',
  exportDng: 'dng',
  exportEmbeddedJpg: 'embeddedJpg'
}
/** The text actions of the menu items whose keys a text field also uses. */
const TEXT_ACTIONS: Partial<Record<MenuCommand, string>> = {
  undoEdit: 'undo',
  redoEdit: 'redo',
  selectAll: 'selectAll'
}

export async function checkForUpdates(manual = true): Promise<void> {
  if (appInfo.platform !== 'darwin') return
  try {
    await ipc.invoke('update:check', { manual })
  } catch (error) {
    console.error('Could not check for updates', error)
  }
}

/** Returns true when it ran. Return false to let the next handler or the default run. */
type Handler = (options: CommandOptions) => boolean

const handlers = new Map<MenuCommand, Handler[]>()

/**
 * Adds handlers for commands that need component state, such as crop mode or the zoom of
 * a preview. The most recent handler runs first. Returns a function that removes them.
 */
export function registerCommands(entries: Partial<Record<MenuCommand, Handler>>): () => void {
  const added = Object.entries(entries) as [MenuCommand, Handler][]
  for (const [name, handler] of added) handlers.set(name, [handler, ...(handlers.get(name) ?? [])])
  return () => {
    for (const [name, handler] of added)
      handlers.set(
        name,
        (handlers.get(name) ?? []).filter((other) => other !== handler)
      )
  }
}

/**
 * Runs a command from the menu bar, a key, or a context menu. Returns true when the
 * command applied, so that a key handler can prevent the default action only then.
 */
export function runCommand(name: MenuCommand, options: CommandOptions = {}): boolean {
  // In a text field, also in a dialog, Undo, Redo, and Select All act on the text. A key
  // keeps its default action. On macOS the menu item gets the key when the page does not
  // use it, and then does the text action.
  const text = TEXT_ACTIONS[name]
  if (text && isTextEditing(document.activeElement)) {
    if (options.source !== 'menu') return false
    document.execCommand(text)
    return true
  }
  const editor = useEditorStore.getState()
  // A modal dialog owns the keys and the menu bar until it closes.
  if (editor.closing || document.querySelector('[role="dialog"][data-state="open"]')) return false
  for (const handler of handlers.get(name) ?? []) if (handler(options)) return true
  return runDefault(name, options)
}

function runDefault(name: MenuCommand, { advance, toggle }: CommandOptions): boolean {
  const q = useQueueStore.getState()
  const editor = useEditorStore.getState()
  const settings = useSettingsStore.getState()
  const screen = useNavStore.getState().screen
  const library = screen === 'queue'
  const mode = settings.settings.queueViewMode
  if (name === 'pick' || name === 'reject' || name === 'unflag')
    return cull({ flag: name === 'unflag' ? 'unflagged' : name }, { advance, toggle })
  const rating = /^rate([0-5])$/.exec(name)
  if (rating) return cull({ rating: Number(rating[1]) }, { advance })
  if (name === 'ratingUp' || name === 'ratingDown')
    return stepRating(name === 'ratingUp' ? 1 : -1, advance)
  if (['undoEdit', 'redoEdit', 'copyEdits', 'pasteEdits'].includes(name)) {
    // Crop mode hides copy and paste; their commands wait too.
    const copying = name === 'copyEdits' || name === 'pasteEdits'
    if (q.isProcessing || screen === 'export' || (editor.cropping && copying)) return false
    if (name === 'copyEdits') editor.copy()
    else if (name === 'pasteEdits') void editor.paste()
    else if (screen === 'editor') {
      if (name === 'undoEdit') editor.undo()
      else editor.redo()
    } else return false
    return true
  }
  const preset = EXPORTS[name]
  if (name === 'exportSelected' || preset) {
    const returnScreen = screen === 'editor' ? 'editor' : 'queue'
    const targets = cullTargets(q, mode, screen)
    if (
      screen === 'export' ||
      q.isProcessing ||
      q.isPreparing ||
      q.draft ||
      !targets.length ||
      targets.some((file) => file.pending) ||
      (preset === 'previous' && !settings.settings.hasPreviousConversion) ||
      // The editor offers only the formats that include the edit.
      (returnScreen === 'editor' && (preset === 'dng' || preset === 'embeddedJpg'))
    )
      return false
    const ids = new Set(targets.map((file) => file.id))
    if (preset) exportWith(preset, ids, returnScreen)
    else q.openExport(ids, returnScreen)
    return true
  }
  const view = VIEWS[name]
  if (view) {
    if (!library || !settings.loaded || !q.files.length) return false
    void settings.update({ queueViewMode: view })
    return true
  }
  const sort = SORTS[name]
  if (sort) {
    if (!settings.loaded) return false
    void settings.update(sort)
    return true
  }
  if (
    editor.session &&
    ['removeSelected', 'clearQueue', 'addFiles', 'addFolder', 'convertAll'].includes(name)
  ) {
    if (q.isProcessing || q.isPreparing || q.draft) return false
    void editor.close().then((closed) => {
      if (closed) runCommand(name)
    })
    return true
  }
  switch (name) {
    case 'addFiles':
      void addFilesViaDialog()
      return true
    case 'addFolder':
      void addFolderViaDialog()
      return true
    case 'editPhoto': {
      // As the Edit button: the active photo, or the first selected one.
      const selected = q.files.filter((file) => q.selectedIds.has(file.id))
      const file = selected.find((other) => other.id === q.activeId) ?? selected[0]
      if (
        !library ||
        !file ||
        !settings.loaded ||
        selected.some((other) => other.pending) ||
        q.isProcessing ||
        q.isPreparing ||
        q.draft
      )
        return false
      void editor.open(file)
      return true
    }
    case 'showInFinder': {
      const files = q.files.filter((file) =>
        screen === 'editor' ? file.path === editor.session?.path : q.selectedIds.has(file.id)
      )
      for (const file of files)
        ipc.invoke('shell:reveal', { path: file.path }).catch((error: unknown) => {
          console.error('Could not reveal file', error)
        })
      return files.length > 0
    }
    case 'selectAll':
      q.selectAll()
      return true
    case 'deselectAll':
      q.deselectAll()
      return true
    case 'invertSelection': {
      if (!library) return false
      const shown = shownFiles(q).filter((file) => !q.selectedIds.has(file.id))
      q.setSelection(new Set(shown.map((file) => file.id)))
      return true
    }
    case 'toggleFilterBar':
      if (!library || !q.files.length) return false
      q.toggleFilterBar()
      return true
    case 'toggleStrip':
      if (screen === 'export' || (library && mode !== 'filmstrip')) return false
      q.toggleStrip()
      return true
    case 'togglePanel':
      if (screen === 'export') return false
      void settings.update(
        screen === 'editor'
          ? { editorPanelOpen: !settings.settings.editorPanelOpen }
          : { inspectorOpen: !settings.settings.inspectorOpen }
      )
      return true
    case 'previousPhoto':
    case 'nextPhoto': {
      // The filmstrip and the editor show one photo. The editor follows the active photo.
      if (screen === 'editor' ? editor.cropping : !library || mode !== 'filmstrip') return false
      const shown = shownFiles(q)
      // Without a cursor, the filmstrip shows its first photo, and the editor its open photo.
      const current = q.activeId ?? q.files.find((file) => file.path === editor.session?.path)?.id
      const index = Math.max(
        0,
        shown.findIndex((file) => file.id === current)
      )
      const next = shown[index + (name === 'nextPhoto' ? 1 : -1)]
      if (next) q.setSelection(new Set([next.id]), next.id)
      return shown.length > 0
    }
    case 'removeSelected':
      q.removeSelected()
      return true
    case 'convertAll':
      void q.convertAllMenu()
      return true
    case 'stop':
      q.stop()
      return true
    case 'clearQueue':
      q.clearQueue()
      return true
    case 'help':
      invoke('plugin:opener|open_url', { url: HELP_URL }).catch((error: unknown) => {
        console.error('Could not open help', error)
      })
      return true
    case 'showLogs':
      void ipc.invoke('logs:open')
      return true
    case 'checkForUpdates':
      void checkForUpdates()
      return true
    default:
      return false
  }
}
