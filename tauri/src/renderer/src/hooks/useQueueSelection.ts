import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { arrowTargetIndex, type ArrowNav } from '../lib/queueNavigation'

export interface QueueSelection {
  handleItemClick: (e: MouseEvent, id: string, index: number) => void
  handleItemDoubleClick: (id: string) => void
  handleItemContextMenu: (id: string) => void
  handleContainerContextMenu: () => void
  handleKeyDown: (e: KeyboardEvent) => void
}

/**
 * Shared selection + interaction behavior for every queue view (list, grid,
 * filmstrip): selection, context menus, and arrow-key navigation. Double-click
 * opens list/grid items in the filmstrip; filmstrip cells open batch settings.
 *
 * `ordered` is the files in their on-screen order (post-sort); shift-range, the
 * anchor, and arrow movement are computed against it. `nav` describes how arrow
 * keys map to movement for the current view (omit to disable arrow nav).
 *
 * The returned object and its handlers are referentially stable — they read
 * `ordered`/`nav` through refs — so memoized rows/cells receiving them don't
 * re-render when the list changes.
 */
export function useQueueSelection(ordered: X3FFileDTO[], nav?: ArrowNav): QueueSelection {
  const anchorRef = useRef<string | null>(null)
  // Set by a row's onContextMenu so the container handler can tell row vs. empty.
  const itemHandledCtx = useRef(false)
  const order = useMemo(() => {
    const ids = ordered.map((file) => file.id)
    return { ids, indices: new Map(ids.map((id, index) => [id, index])) }
  }, [ordered])
  const orderedRef = useRef(order)
  orderedRef.current = order
  const navRef = useRef(nav)
  navRef.current = nav

  const handleItemClick = useCallback((e: MouseEvent, id: string, index: number): void => {
    const store = useQueueStore.getState()
    const current = store.selectedIds
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      store.setSelection(next, id)
      anchorRef.current = id
    } else if (e.shiftKey && anchorRef.current) {
      const ids = orderedRef.current.ids
      const a = orderedRef.current.indices.get(anchorRef.current) ?? -1
      const b = index
      const [lo, hi] = a < b ? [a, b] : [b, a]
      store.setSelection(new Set(ids.slice(lo, hi + 1)), id)
    } else {
      store.setSelection(new Set([id]), id)
      anchorRef.current = id
    }
  }, [])

  const handleItemDoubleClick = useCallback((id: string): void => {
    const store = useQueueStore.getState()
    const target = store.selectedIds.has(id) ? store.selectedIds : new Set([id])
    if (navRef.current?.mode === 'vertical' || navRef.current?.mode === 'grid') {
      store.setSelection(target, id)
      void useSettingsStore.getState().update({ queueViewMode: 'filmstrip' })
      return
    }
    store.openExport(target)
  }, [])

  const handleItemContextMenu = useCallback((id: string): void => {
    itemHandledCtx.current = true
    const store = useQueueStore.getState()
    if (!store.selectedIds.has(id)) {
      store.setSelection(new Set([id]), id)
      anchorRef.current = id
    }
  }, [])

  const handleContainerContextMenu = useCallback((): void => {
    // Bubbles up after any item handler; if no item claimed it, it was empty space.
    if (!itemHandledCtx.current) useQueueStore.getState().deselectAll()
    itemHandledCtx.current = false
  }, [])

  /** Move the cursor to `target`; plain = single-select, shift = extend range. */
  const moveCursor = useCallback((target: number, extend: boolean): void => {
    const store = useQueueStore.getState()
    const ids = orderedRef.current.ids
    const targetId = ids[target]
    if (!targetId) return

    if (extend) {
      // Extend the contiguous range from the fixed anchor to the new cursor.
      const anchorId =
        anchorRef.current && orderedRef.current.indices.has(anchorRef.current)
          ? anchorRef.current
          : (store.activeId ?? targetId)
      anchorRef.current = anchorId
      const a = orderedRef.current.indices.get(anchorId) ?? -1
      const [lo, hi] = a < target ? [a, target] : [target, a]
      store.setSelection(new Set(ids.slice(lo, hi + 1)), targetId)
    } else {
      store.setSelection(new Set([targetId]), targetId)
      anchorRef.current = targetId
    }
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent | globalThis.KeyboardEvent): void => {
      const store = useQueueStore.getState()
      if ((e.key === 'Backspace' || e.key === 'Delete') && store.selectedIds.size > 0) {
        e.preventDefault()
        store.removeSelected()
        return
      }

      const currentNav = navRef.current
      if (currentNav) {
        const ids = orderedRef.current.ids
        const current = store.activeId ? (orderedRef.current.indices.get(store.activeId) ?? -1) : -1
        const target = arrowTargetIndex(current, e.key, currentNav, ids.length)
        if (target !== null) {
          e.preventDefault()
          moveCursor(target, e.shiftKey)
        }
      }
    },
    [moveCursor]
  )

  // Titlebar/background clicks can leave focus on the document instead of the queue.
  useEffect(() => {
    const isBackground = (target: EventTarget | null): boolean =>
      target === document || target === document.body || target === document.documentElement
    const handleBackgroundKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) ||
        !isBackground(event.target) ||
        (document.activeElement !== null && !isBackground(document.activeElement)) ||
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [aria-haspopup="menu"][aria-expanded="true"]'
        )
      )
        return
      handleKeyDown(event)
    }
    document.addEventListener('keydown', handleBackgroundKeyDown)
    return () => document.removeEventListener('keydown', handleBackgroundKeyDown)
  }, [handleKeyDown])

  return useMemo(
    () => ({
      handleItemClick,
      handleItemDoubleClick,
      handleItemContextMenu,
      handleContainerContextMenu,
      handleKeyDown
    }),
    [
      handleItemClick,
      handleItemDoubleClick,
      handleItemContextMenu,
      handleContainerContextMenu,
      handleKeyDown
    ]
  )
}
