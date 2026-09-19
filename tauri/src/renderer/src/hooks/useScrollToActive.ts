import { useEffect } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { X3FFileDTO } from '@shared/types'

/**
 * Keep the keyboard cursor (the active item) scrolled into view in a
 * virtualized queue view. `columns` maps an item index to its virtualized row
 * for grid layouts; list views use the default of one item per row.
 */
export function useScrollToActive(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  ordered: X3FFileDTO[],
  activeId: string | null,
  columns = 1
): void {
  useEffect(() => {
    if (!activeId) return
    const idx = ordered.findIndex((f) => f.id === activeId)
    if (idx >= 0) virtualizer.scrollToIndex(Math.floor(idx / columns), { align: 'auto' })
    // Re-scroll only when the cursor or the row geometry moves, not on every
    // list mutation (progress ticks replace `ordered` constantly).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, columns])
}
