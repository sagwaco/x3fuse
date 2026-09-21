import { useEffect } from 'react'
import type { MenuCommand } from '@shared/ipc'
import { ipc } from '../lib/ipc'
import { useQueueStore } from '../stores/queueStore'
import { addFilesViaDialog } from '../lib/addFilesViaDialog'
import { useEditorStore, isTextEditing } from '../stores/editorStore'
import { useNavStore } from '../stores/navStore'

/**
 * Subscribes the main window to main->renderer events and the native-menu
 * command bus, dispatching each into the queue store. Mount once (App).
 */
export function useIpcEvents(): void {
  useEffect(() => {
    const q = useQueueStore.getState

    const unsubscribers = [
      ipc.on('editor:closing', ({ quit }) => {
        if (useEditorStore.getState().closing) return
        useEditorStore.setState({ closing: true })
        void useEditorStore
          .getState()
          .flush()
          .then(async (saved) => {
            if (saved) await ipc.invoke('editor:finishClose', { quit })
            else useEditorStore.setState({ closing: false })
          })
          .catch((error: unknown) =>
            useEditorStore.setState({ closing: false, error: String(error) })
          )
      }),
      ipc.on('batch:started', (p) => q().onBatchStarted(p)),
      ipc.on('file:status', (p) => q().applyStatus(p)),
      ipc.on('file:progress', (p) => q().applyProgress(p)),
      ipc.on('batch:complete', (p) => q().onBatchComplete(p)),
      ipc.on('menu:command', ({ name }) => handleMenuCommand(name))
    ]

    return () => unsubscribers.forEach((off) => off())
  }, [])
}

function handleMenuCommand(name: MenuCommand): void {
  const q = useQueueStore.getState()
  const editor = useEditorStore.getState()
  if (editor.closing) return
  if (['undoEdit', 'redoEdit', 'copyEdits', 'pasteEdits'].includes(name)) {
    if (isTextEditing(document.activeElement) || q.isProcessing) return
    if (name === 'copyEdits') editor.copy()
    else if (name === 'pasteEdits') void editor.paste()
    else if (useNavStore.getState().screen === 'editor') {
      if (name === 'undoEdit') editor.undo()
      else editor.redo()
    }
    return
  }
  if (editor.session && ['removeSelected', 'clearQueue', 'addFiles', 'convertAll'].includes(name)) {
    if (q.isProcessing || q.isPreparing || q.draft) return
    void editor.close().then((closed) => {
      if (closed) handleMenuCommand(name)
    })
    return
  }
  switch (name) {
    case 'addFiles':
      void addFilesViaDialog()
      break
    case 'selectAll':
      q.selectAll()
      break
    case 'deselectAll':
      q.deselectAll()
      break
    case 'removeSelected':
      q.removeSelected()
      break
    case 'convertAll':
      void q.convertAllMenu()
      break
    case 'stop':
      q.stop()
      break
    case 'clearQueue':
      q.clearQueue()
      break
    case 'showLogs':
      void ipc.invoke('logs:open')
      break
    case 'checkForUpdates':
      void ipc.invoke('update:check')
      break
  }
}
