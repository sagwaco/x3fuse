// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Switch } from '../src/renderer/src/components/ui/switch'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('shows the glass knob while pressed and for a moment after release', () => {
  vi.useFakeTimers()
  vi.stubGlobal('PointerEvent', MouseEvent)
  const change = vi.fn()
  render(<Switch aria-label="Test" checked={false} onCheckedChange={change} />)
  const toggle = screen.getByRole('switch', { name: 'Test' })
  fireEvent.pointerDown(toggle, { button: 2 })
  expect(toggle.hasAttribute('data-pressed')).toBe(false)
  fireEvent.pointerDown(toggle, { button: 0 })
  expect(toggle.hasAttribute('data-pressed')).toBe(true)
  // A release anywhere ends the press, after a short hold.
  fireEvent.pointerUp(window)
  act(() => vi.advanceTimersByTime(150))
  expect(toggle.hasAttribute('data-pressed')).toBe(true)
  act(() => vi.advanceTimersByTime(50))
  expect(toggle.hasAttribute('data-pressed')).toBe(false)
})
