import { useRef, useState, type PointerEvent, type RefObject } from 'react'
import { useQueueStore } from '../stores/queueStore'

/** A rectangle in the scroll content's coordinates. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** Movement in pixels before a press becomes a drag. */
const THRESHOLD = 4

/**
 * Drag to select a range of items with a rectangle, as in Finder.
 * `hit` returns the IDs of the items that the rectangle touches, in order.
 * The views are virtualized, so `hit` uses geometry, not the DOM.
 * Command or Control toggles the touched items. Shift adds them.
 * Elements with `data-no-marquee` do not start a drag.
 */
export function useMarquee(
  scrollRef: RefObject<HTMLElement>,
  hit: (box: Box) => string[]
): { box: Box | null; onPointerDown: (event: PointerEvent) => void } {
  const [box, setBox] = useState<Box | null>(null)
  const hitRef = useRef(hit)
  hitRef.current = hit

  const onPointerDown = (event: PointerEvent): void => {
    const element = scrollRef.current
    if (!element || event.button !== 0) return
    if ((event.target as Element).closest('[data-no-marquee]')) return
    const point = (x: number, y: number): { x: number; y: number } => {
      const rect = element.getBoundingClientRect()
      return { x: x - rect.left + element.scrollLeft, y: y - rect.top + element.scrollTop }
    }
    const start = point(event.clientX, event.clientY)
    const toggle = event.metaKey || event.ctrlKey
    const base = toggle || event.shiftKey ? useQueueStore.getState().selectedIds : new Set<string>()
    let client = { x: event.clientX, y: event.clientY }
    let dragging = false

    const update = (): void => {
      const end = point(client.x, client.y)
      if (!dragging && Math.hypot(end.x - start.x, end.y - start.y) < THRESHOLD) return
      dragging = true
      const next = {
        left: Math.min(start.x, end.x),
        top: Math.min(start.y, end.y),
        right: Math.max(start.x, end.x),
        bottom: Math.max(start.y, end.y)
      }
      setBox(next)
      const ids = hitRef.current(next)
      const selection = new Set(base)
      for (const id of ids) {
        if (toggle && base.has(id)) selection.delete(id)
        else selection.add(id)
      }
      useQueueStore.getState().setSelection(selection, ids.at(-1))
    }
    const move = (e: globalThis.PointerEvent): void => {
      client = { x: e.clientX, y: e.clientY }
      update()
    }
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      element.removeEventListener('scroll', update)
      setBox(null)
      if (!dragging) return
      // The click after a drag must not select an item or clear the selection.
      const swallow = (e: MouseEvent): void => e.stopPropagation()
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    // Scrolling during a drag moves the rectangle's far corner.
    element.addEventListener('scroll', update)
  }

  return { box, onPointerDown }
}
