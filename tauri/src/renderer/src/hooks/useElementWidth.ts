import { useEffect, useState, type RefObject } from 'react'

/**
 * Track an element's content width via ResizeObserver. Used by the grid view to
 * compute how many thumbnail columns fit. Returns 0 until first measured (in
 * which case callers should fall back to a single column).
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width)
    })
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [ref])

  return width
}
