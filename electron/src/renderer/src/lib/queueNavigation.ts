/**
 * Pure arrow-key navigation math for the queue views, kept separate from React
 * so it can be unit-tested. Each view maps arrows to a different movement:
 *   - list      → vertical   (Up/Down)
 *   - filmstrip → horizontal (Left/Right)
 *   - grid      → both, where Up/Down jump a full row (`columns`)
 */
export type ArrowNav =
  | { mode: 'vertical' }
  | { mode: 'horizontal' }
  | { mode: 'grid'; columns: number }

/** Index delta for a key under a nav mode, or null if the key isn't a nav key. */
function arrowDelta(key: string, nav: ArrowNav): number | null {
  switch (nav.mode) {
    case 'vertical':
      if (key === 'ArrowDown') return 1
      if (key === 'ArrowUp') return -1
      return null
    case 'horizontal':
      if (key === 'ArrowRight') return 1
      if (key === 'ArrowLeft') return -1
      return null
    case 'grid': {
      const row = Math.max(1, nav.columns)
      if (key === 'ArrowRight') return 1
      if (key === 'ArrowLeft') return -1
      if (key === 'ArrowDown') return row
      if (key === 'ArrowUp') return -row
      return null
    }
  }
}

/**
 * Target index for an arrow press, or null when `key` isn't a navigation key for
 * this view (so the caller leaves the event alone). `current` is the cursor's
 * current index, or -1 when nothing is selected yet (first press lands on an end).
 */
export function arrowTargetIndex(
  current: number,
  key: string,
  nav: ArrowNav,
  length: number
): number | null {
  if (length === 0) return null
  const delta = arrowDelta(key, nav)
  if (delta === null) return null
  if (current < 0) return delta > 0 ? 0 : length - 1
  return Math.min(length - 1, Math.max(0, current + delta))
}
