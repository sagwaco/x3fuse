import { useEffect } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { X3FFileDTO } from '@shared/types'
import { setShownRows } from '../stores/queueStore'

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

/**
 * Tell the import which pending rows a virtualized view renders, so that a view
 * scrolled away from the active item loads its rows first.
 */
export function useShownRows(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  ordered: X3FFileDTO[],
  columns = 1
): void {
  const items = virtualizer.getVirtualItems()
  const first = (items[0]?.index ?? 0) * columns
  const last = ((items.at(-1)?.index ?? -1) + 1) * columns
  const ids = ordered
    .slice(first, last)
    .filter((file) => file.pending)
    .map((file) => file.id)
    .join('\n')
  useEffect(() => {
    setShownRows(virtualizer, ids ? ids.split('\n') : null)
    return () => setShownRows(virtualizer, null)
  }, [virtualizer, ids])
}
