import type { CommandOptions, MenuCommand } from '@shared/ipc'
import { ipc } from './ipc'
import { appInfo } from './appInfo'
import { addFilesViaDialog, addFolderViaDialog } from './addFilesViaDialog'
import { useQueueStore } from '../stores/queueStore'
import { useEditorStore, isTextEditing } from '../stores/editorStore'
import { useNavStore } from '../stores/navStore'
import { cull } from '../hooks/useCulling'

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
  const editor = useEditorStore.getState()
  if (editor.closing) return false
  for (const handler of handlers.get(name) ?? []) if (handler(options)) return true
  return runDefault(name, options)
}

function runDefault(name: MenuCommand, { advance, toggle }: CommandOptions): boolean {
  const q = useQueueStore.getState()
  const editor = useEditorStore.getState()
  if (name === 'pick' || name === 'reject' || name === 'unflag') {
    cull({ flag: name === 'unflag' ? 'unflagged' : name }, { advance, toggle })
    return true
  }
  const rating = /^rate([0-5])$/.exec(name)
  if (rating) {
    cull({ rating: Number(rating[1]) }, { advance })
    return true
  }
  if (['undoEdit', 'redoEdit', 'copyEdits', 'pasteEdits'].includes(name)) {
    if (isTextEditing(document.activeElement) || q.isProcessing) return false
    if (name === 'copyEdits') editor.copy()
    else if (name === 'pasteEdits') void editor.paste()
    else if (useNavStore.getState().screen === 'editor') {
      if (name === 'undoEdit') editor.undo()
      else editor.redo()
    } else return false
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
    case 'selectAll':
      q.selectAll()
      return true
    case 'deselectAll':
      q.deselectAll()
      return true
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
