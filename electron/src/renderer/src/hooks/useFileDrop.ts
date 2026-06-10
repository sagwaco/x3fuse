import { useCallback, useRef, useState, type DragEvent } from 'react'
import { ipc } from '../lib/ipc'
import { useQueueStore } from '../stores/queueStore'

interface FileDrop {
  isDragOver: boolean
  dropHandlers: {
    onDragEnter: (e: DragEvent) => void
    onDragOver: (e: DragEvent) => void
    onDragLeave: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
}

/**
 * HTML5 drag-and-drop that resolves dropped File objects to absolute paths via
 * the preload's webUtils bridge (Electron >=32 removed File.path), filters to
 * .x3f, and adds them to the queue. A depth counter keeps `isDragOver` stable
 * while the cursor moves over child elements.
 */
export function useFileDrop(): FileDrop {
  const [isDragOver, setDragOver] = useState(false)
  const depth = useRef(0)

  const onDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault()
    depth.current += 1
    setDragOver(true)
  }, [])

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
  }, [])

  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    depth.current -= 1
    if (depth.current <= 0) {
      depth.current = 0
      setDragOver(false)
    }
  }, [])

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    depth.current = 0
    setDragOver(false)
    const paths: string[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = ipc.pathForFile(file)
      if (p && p.toLowerCase().endsWith('.x3f')) paths.push(p)
    }
    if (paths.length > 0) void useQueueStore.getState().addFiles(paths)
  }, [])

  return { isDragOver, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}
