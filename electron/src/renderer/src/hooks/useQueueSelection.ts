import { useRef, type KeyboardEvent, type MouseEvent } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { arrowTargetIndex, type ArrowNav } from '../lib/queueNavigation'

/**
 * Shared selection + interaction behavior for every queue view (list, grid,
 * filmstrip), so cmd/shift multi-select, the active-item tracking, double-click
 * convert, the row-vs-empty-space context menu, and arrow-key navigation all
 * behave identically.
 *
 * `ordered` is the files in their on-screen order (post-sort); shift-range, the
 * anchor, and arrow movement are computed against it. `nav` describes how arrow
 * keys map to movement for the current view (omit to disable arrow nav).
 */
export function useQueueSelection(
  ordered: X3FFileDTO[],
  nav?: ArrowNav
): {
  handleItemClick: (e: MouseEvent, id: string, index: number) => void
  handleItemDoubleClick: (id: string) => void
  handleItemContextMenu: (id: string) => void
  handleContainerContextMenu: () => void
  handleKeyDown: (e: KeyboardEvent) => void
} {
  const anchorRef = useRef<string | null>(null)
  // Set by a row's onContextMenu so the container handler can tell row vs. empty.
  const itemHandledCtx = useRef(false)

  function handleItemClick(e: MouseEvent, id: string, index: number): void {
    const store = useQueueStore.getState()
    const current = store.selectedIds
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      store.setSelection(next, id)
      anchorRef.current = id
    } else if (e.shiftKey && anchorRef.current) {
      const ids = ordered.map((f) => f.id)
      const a = ids.indexOf(anchorRef.current)
      const b = index
      const [lo, hi] = a < b ? [a, b] : [b, a]
      store.setSelection(new Set(ids.slice(lo, hi + 1)), id)
    } else {
      store.setSelection(new Set([id]), id)
      anchorRef.current = id
    }
  }

  function handleItemDoubleClick(id: string): void {
    const store = useQueueStore.getState()
    const target = store.selectedIds.has(id) ? store.selectedIds : new Set([id])
    void store.doubleClickConvert(target)
  }

  function handleItemContextMenu(id: string): void {
    itemHandledCtx.current = true
    const store = useQueueStore.getState()
    if (!store.selectedIds.has(id)) {
      store.setSelection(new Set([id]), id)
      anchorRef.current = id
    }
  }

  function handleContainerContextMenu(): void {
    // Bubbles up after any item handler; if no item claimed it, it was empty space.
    if (!itemHandledCtx.current) useQueueStore.getState().deselectAll()
    itemHandledCtx.current = false
  }

  /** Move the cursor to `target`; plain = single-select, shift = extend range. */
  function moveCursor(target: number, extend: boolean): void {
    const store = useQueueStore.getState()
    const ids = ordered.map((f) => f.id)
    const targetId = ids[target]
    if (!targetId) return

    if (extend) {
      // Extend the contiguous range from the fixed anchor to the new cursor.
      const anchorId =
        anchorRef.current && ids.includes(anchorRef.current)
          ? anchorRef.current
          : (store.activeId ?? targetId)
      anchorRef.current = anchorId
      const a = ids.indexOf(anchorId)
      const [lo, hi] = a < target ? [a, target] : [target, a]
      store.setSelection(new Set(ids.slice(lo, hi + 1)), targetId)
    } else {
      store.setSelection(new Set([targetId]), targetId)
      anchorRef.current = targetId
    }
  }

  function handleKeyDown(e: KeyboardEvent): void {
    const store = useQueueStore.getState()
    if ((e.key === 'Backspace' || e.key === 'Delete') && store.selectedIds.size > 0) {
      e.preventDefault()
      store.removeSelected()
      return
    }

    if (nav) {
      const ids = ordered.map((f) => f.id)
      const current = store.activeId ? ids.indexOf(store.activeId) : -1
      const target = arrowTargetIndex(current, e.key, nav, ids.length)
      if (target !== null) {
        e.preventDefault()
        moveCursor(target, e.shiftKey)
      }
    }
  }

  return {
    handleItemClick,
    handleItemDoubleClick,
    handleItemContextMenu,
    handleContainerContextMenu,
    handleKeyDown
  }
}
