import { useEffect } from 'react'
import type { MenuCommand } from '@shared/ipc'
import { ipc } from '../lib/ipc'
import { useQueueStore } from '../stores/queueStore'
import { addFilesViaDialog } from '../lib/addFilesViaDialog'

/**
 * Subscribes the main window to main->renderer events and the native-menu
 * command bus, dispatching each into the queue store. Mount once (App).
 */
export function useIpcEvents(): void {
  useEffect(() => {
    const q = useQueueStore.getState

    const unsubscribers = [
      ipc.on('file:status', (p) => q().applyStatus(p)),
      ipc.on('file:progress', (p) => q().applyProgress(p)),
      ipc.on('batch:complete', () => q().onBatchComplete()),
      ipc.on('menu:command', ({ name }) => handleMenuCommand(name))
    ]

    return () => unsubscribers.forEach((off) => off())
  }, [])
}

function handleMenuCommand(name: MenuCommand): void {
  const q = useQueueStore.getState()
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
    case 'removeFailed':
      q.removeFailed()
      break
    case 'removeCompleted':
      q.removeCompleted()
      break
    case 'showLogs':
      void ipc.invoke('logs:open')
      break
    case 'checkForUpdates':
      void ipc.invoke('update:check')
      break
  }
}
