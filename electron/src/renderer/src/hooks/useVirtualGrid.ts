import type { RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useElementWidth } from './useElementWidth'

/** Shared row virtualization for the queue and export thumbnail grids. */
export function useVirtualGrid(
  parentRef: RefObject<HTMLDivElement>,
  itemCount: number,
  {
    padding,
    gap,
    minCell,
    rowHeight
  }: {
    padding: number
    gap: number
    minCell: number
    rowHeight: number
  }
) {
  const width = useElementWidth(parentRef)
  const columns = Math.max(1, Math.floor((width - 2 * padding + gap) / (minCell + gap)))
  const virtualizer = useVirtualizer({
    count: Math.ceil(itemCount / columns),
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    paddingStart: itemCount > 0 ? padding : 0,
    scrollPaddingStart: padding,
    overscan: 4
  })
  return { columns, virtualizer }
}
