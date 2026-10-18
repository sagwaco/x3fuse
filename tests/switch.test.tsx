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

it('keeps a new press on when the hold of the last press ends', () => {
  vi.useFakeTimers()
  vi.stubGlobal('PointerEvent', MouseEvent)
  render(<Switch aria-label="Test" checked={false} onCheckedChange={() => {}} />)
  const toggle = screen.getByRole('switch', { name: 'Test' })
  fireEvent.pointerDown(toggle, { button: 0 })
  fireEvent.pointerUp(window)
  act(() => vi.advanceTimersByTime(100))
  fireEvent.pointerDown(toggle, { button: 0 })
  act(() => vi.advanceTimersByTime(300))
  expect(toggle.hasAttribute('data-pressed')).toBe(true)
  fireEvent.pointerUp(window)
  act(() => vi.advanceTimersByTime(200))
  expect(toggle.hasAttribute('data-pressed')).toBe(false)
})

it('removes its release listener on unmount', () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const add = vi.spyOn(window, 'addEventListener')
  const remove = vi.spyOn(window, 'removeEventListener')
  const { unmount } = render(
    <Switch aria-label="Test" checked={false} onCheckedChange={() => {}} />
  )
  fireEvent.pointerDown(screen.getByRole('switch', { name: 'Test' }), { button: 0 })
  const listener = add.mock.calls.find(([type]) => type === 'pointerup')![1]
  unmount()
  expect(remove).toHaveBeenCalledWith('pointerup', listener)
  add.mockRestore()
  remove.mockRestore()
})
