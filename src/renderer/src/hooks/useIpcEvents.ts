import { useEffect } from 'react'
import { ipc } from '../lib/ipc'
import { checkForUpdates, runCommand } from '../lib/commands'
import { cullingSaved, useQueueStore } from '../stores/queueStore'
import { useEditorStore } from '../stores/editorStore'

/**
 * Subscribes the main window to main->renderer events and the native-menu
 * command bus, dispatching each into the queue store. Mount once (App).
 */
export function useIpcEvents(): void {
  useEffect(() => {
    const frame = requestAnimationFrame(() => void checkForUpdates(false))
    const refreshSfd = (): void => {
      if (useEditorStore.getState().x3i) void useEditorStore.getState().refreshX3i()
    }
    window.addEventListener('focus', refreshSfd)
    const q = useQueueStore.getState

    const unsubscribers = [
      ipc.on('editor:closing', ({ quit }) => {
        if (useEditorStore.getState().closing) return
        useEditorStore.setState({ closing: true })
        void useEditorStore
          .getState()
          .flush()
          .then(async (saved) => {
            if (!saved) return useEditorStore.setState({ closing: false })
            // Close only after queued flags and ratings reach the backend.
            await cullingSaved()
            await ipc.invoke('editor:finishClose', { quit })
          })
          .catch((error: unknown) =>
            useEditorStore.setState({ closing: false, error: String(error) })
          )
      }),
      ipc.on('batch:started', (p) => q().onBatchStarted(p)),
      ipc.on('file:status', (p) => q().applyStatus(p)),
      ipc.on('file:progress', (p) => q().applyProgress(p)),
      ipc.on('batch:complete', (p) => q().onBatchComplete(p)),
      ipc.on('menu:command', ({ name }) => void runCommand(name, { source: 'menu' }))
    ]

    return () => {
      window.removeEventListener('focus', refreshSfd)
      cancelAnimationFrame(frame)
      unsubscribers.forEach((off) => off())
    }
  }, [])
}
