// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Adjustment } from '../src/renderer/src/components/EditorControls'
import { Slider } from '../src/renderer/src/components/ui/slider'
import { Switch } from '../src/renderer/src/components/ui/switch'
import { GlassGroup } from '../src/renderer/src/components/ui/glassGroup'

vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke: vi.fn(async () => {}) } }))

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps numeric editing focused until Enter and consumes the commit key', () => {
  const shortcut = vi.fn()
  const change = vi.fn()
  render(
    <div onKeyDown={shortcut}>
      <Adjustment label="Exposure" value={0} change={change} reset={() => {}} disabled={false} />
    </div>
  )
  const input = screen.getByRole('spinbutton')
  act(() => input.focus())
  fireEvent.change(input, { target: { value: '1' } })
  expect(change).toHaveBeenCalledWith(1, true)
  expect(document.activeElement).toBe(input)
  expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
  expect(document.activeElement).toBe(document.body)
  expect(shortcut).not.toHaveBeenCalled()
})

it.each([{ isComposing: true }, { keyCode: 229 }])(
  'keeps focus for IME confirmation (%j)',
  (ime) => {
    render(
      <Adjustment label="Exposure" value={0} change={() => {}} reset={() => {}} disabled={false} />
    )
    const input = screen.getByRole('spinbutton')
    act(() => input.focus())
    fireEvent.keyDown(input, { key: 'Enter', ...ime })
    expect(document.activeElement).toBe(input)
  }
)

it('keeps the numeric value when Enter follows an empty field', () => {
  const change = vi.fn()
  render(
    <Adjustment label="Exposure" value={2} change={change} reset={() => {}} disabled={false} />
  )
  const input = screen.getByRole('spinbutton') as HTMLInputElement
  act(() => input.focus())
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(input.value).toBe('2')
  expect(change).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(document.body)
})

it('keeps arrow adjustments focused and leaves the slider on Enter', () => {
  const commit = vi.fn()
  function Control(): React.JSX.Element {
    const [value, setValue] = useState(0)
    return (
      <Slider value={value} min={0} max={100} onValueChange={setValue} onValueCommit={commit} />
    )
  }
  render(<Control />)
  const slider = screen.getByRole('slider')
  act(() => slider.focus())
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  expect(slider.getAttribute('aria-valuenow')).toBe('2')
  expect(commit).toHaveBeenLastCalledWith(2)
  expect(document.activeElement).toBe(slider)
  fireEvent.keyDown(slider, { key: 'Enter' })
  expect(document.activeElement).toBe(document.body)
})

it('slides only with the main button', () => {
  const change = vi.fn()
  const view = render(<Slider value={50} min={0} max={100} onValueChange={change} />)
  const root = view.container.firstElementChild as HTMLElement
  root.setPointerCapture = vi.fn()
  root.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20)
  // jsdom has no PointerEvent. A MouseEvent carries the button.
  const press = (button: number, ctrlKey = false): boolean =>
    fireEvent(root, new MouseEvent('pointerdown', { bubbles: true, button, ctrlKey, clientX: 20 }))
  press(2)
  press(0, true)
  expect(change).not.toHaveBeenCalled()
  press(0)
  expect(change).toHaveBeenCalledWith(20)
})

it.each(['pointerUp', 'pointerCancel'] as const)(
  'blurs a slider on %s even without a value change',
  (release) => {
    render(<Slider value={0} min={0} max={100} onValueChange={() => {}} />)
    const slider = screen.getByRole('slider')
    slider.setPointerCapture = vi.fn()
    slider.hasPointerCapture = () => true
    slider.releasePointerCapture = vi.fn()
    act(() => slider.focus())
    fireEvent.pointerDown(slider)
    fireEvent[release](slider)
    expect(document.activeElement).toBe(document.body)
  }
)

it('clears toggle focus after pointer activation and keeps it for keyboard activation', () => {
  const change = vi.fn()
  function Control(): React.JSX.Element {
    const [checked, setChecked] = useState(false)
    return (
      <Switch
        checked={checked}
        onCheckedChange={(next) => {
          change(next)
          setChecked(next)
        }}
      />
    )
  }
  render(<Control />)
  const toggle = screen.getByRole('switch')
  for (const detail of [1, 0]) {
    act(() => toggle.focus())
    fireEvent.click(toggle, { detail })
    expect(document.activeElement).toBe(detail ? document.body : toggle)
  }
  expect(change.mock.calls).toEqual([[true], [false]])
})

it.each([1, 0])('clears pointer focus on a segmented setting (click detail %s)', (detail) => {
  const change = vi.fn()
  render(
    <GlassGroup
      aria-label="Mode"
      value="a"
      items={[
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ]}
      onValueChange={change}
    />
  )
  const choice = screen.getByRole('button', { name: 'B' })
  act(() => choice.focus())
  fireEvent.click(choice, { detail })
  expect(change).toHaveBeenCalledWith('b')
  expect(document.activeElement).toBe(detail ? document.body : choice)
})
