// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useElementWidth } from '../src/renderer/src/hooks/useElementWidth'
import { useVirtualGrid } from '../src/renderer/src/hooks/useVirtualGrid'

vi.mock('../src/renderer/src/hooks/useElementWidth', () => ({ useElementWidth: vi.fn() }))
afterEach(cleanup)

it.each([
  { padding: 12, gap: 12, minCell: 150, rowHeight: 166 },
  { padding: 16, gap: 16, minCell: 160, rowHeight: 182 }
])('keeps grid rows correct across resize and empty queues (%j)', (layout) => {
  const parentRef = { current: null }
  vi.mocked(useElementWidth).mockReturnValue(0)
  const { result, rerender } = renderHook(({ count }) => useVirtualGrid(parentRef, count, layout), {
    initialProps: { count: 5 }
  })
  expect(result.current.columns).toBe(1)
  expect(result.current.virtualizer.getTotalSize()).toBe(5 * layout.rowHeight)

  const twoColumns = 2 * layout.padding + 2 * layout.minCell + layout.gap
  vi.mocked(useElementWidth).mockReturnValue(twoColumns - 1)
  rerender({ count: 5 })
  expect(result.current.columns).toBe(1)
  vi.mocked(useElementWidth).mockReturnValue(twoColumns)
  rerender({ count: 5 })
  expect(result.current.columns).toBe(2)
  expect(result.current.virtualizer.getTotalSize()).toBe(3 * layout.rowHeight)
  rerender({ count: 0 })
  expect(result.current.virtualizer.getTotalSize()).toBe(0)
})
