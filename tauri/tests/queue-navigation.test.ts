import { describe, it, expect } from 'vitest'
import { arrowTargetIndex, type ArrowNav } from '../src/renderer/src/lib/queueNavigation'

const vertical: ArrowNav = { mode: 'vertical' }
const horizontal: ArrowNav = { mode: 'horizontal' }
const grid = (columns: number): ArrowNav => ({ mode: 'grid', columns })

describe('arrowTargetIndex', () => {
  it('vertical: Up/Down move by one, Left/Right are ignored', () => {
    expect(arrowTargetIndex(2, 'ArrowDown', vertical, 10)).toBe(3)
    expect(arrowTargetIndex(2, 'ArrowUp', vertical, 10)).toBe(1)
    expect(arrowTargetIndex(2, 'ArrowLeft', vertical, 10)).toBeNull()
    expect(arrowTargetIndex(2, 'ArrowRight', vertical, 10)).toBeNull()
  })

  it('horizontal: Left/Right move by one, Up/Down are ignored', () => {
    expect(arrowTargetIndex(2, 'ArrowRight', horizontal, 10)).toBe(3)
    expect(arrowTargetIndex(2, 'ArrowLeft', horizontal, 10)).toBe(1)
    expect(arrowTargetIndex(2, 'ArrowDown', horizontal, 10)).toBeNull()
    expect(arrowTargetIndex(2, 'ArrowUp', horizontal, 10)).toBeNull()
  })

  it('grid: Left/Right by one, Up/Down by a full row', () => {
    expect(arrowTargetIndex(5, 'ArrowRight', grid(4), 12)).toBe(6)
    expect(arrowTargetIndex(5, 'ArrowLeft', grid(4), 12)).toBe(4)
    expect(arrowTargetIndex(5, 'ArrowDown', grid(4), 12)).toBe(9)
    expect(arrowTargetIndex(5, 'ArrowUp', grid(4), 12)).toBe(1)
  })

  it('clamps to the valid range at the edges', () => {
    expect(arrowTargetIndex(0, 'ArrowUp', vertical, 10)).toBe(0)
    expect(arrowTargetIndex(9, 'ArrowDown', vertical, 10)).toBe(9)
    // grid Down past the last (partial) row clamps to the last item
    expect(arrowTargetIndex(10, 'ArrowDown', grid(4), 12)).toBe(11)
    expect(arrowTargetIndex(1, 'ArrowUp', grid(4), 12)).toBe(0)
  })

  it('lands on an end when nothing is selected (current = -1)', () => {
    expect(arrowTargetIndex(-1, 'ArrowDown', vertical, 10)).toBe(0)
    expect(arrowTargetIndex(-1, 'ArrowUp', vertical, 10)).toBe(9)
    expect(arrowTargetIndex(-1, 'ArrowRight', horizontal, 10)).toBe(0)
    expect(arrowTargetIndex(-1, 'ArrowLeft', horizontal, 10)).toBe(9)
  })

  it('treats grid columns < 1 as a single column (pre-measurement)', () => {
    expect(arrowTargetIndex(3, 'ArrowDown', grid(0), 10)).toBe(4)
  })

  it('returns null for an empty queue', () => {
    expect(arrowTargetIndex(-1, 'ArrowDown', vertical, 0)).toBeNull()
  })
})
