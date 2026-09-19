import { useEffect, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useQueueStore } from '../stores/queueStore'

/** Native file drops supply absolute paths on all supported webviews. */
export function useFileDrop(): { isDragOver: boolean; dropHandlers: Record<string, never> } {
  const [isDragOver, setDragOver] = useState(false)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (disposed) return
        // The export views mount this hook too; their captured targets stay fixed.
        if (useQueueStore.getState().draft) {
          setDragOver(false)
          return
        }
        setDragOver(payload.type === 'enter' || payload.type === 'over')
        if (payload.type === 'drop') {
          const paths = payload.paths.filter((path) => path.toLowerCase().endsWith('.x3f'))
          if (paths.length) void useQueueStore.getState().addFiles(paths)
        }
      })
      .then((off) => {
        if (disposed) off()
        else unlisten = off
      })
      .catch(console.error)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return { isDragOver, dropHandlers: {} }
}
