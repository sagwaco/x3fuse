// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GlassGroup, type GlassGroupItem } from '../src/renderer/src/components/ui/glassGroup'

const ITEMS: GlassGroupItem<string>[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Gamma' },
  { value: 'd', label: 'Delta', disabled: true }
]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function Tabs({ onChange }: { onChange: (value: string) => void }): React.JSX.Element {
  const [value, setValue] = useState('a')
  return (
    <GlassGroup
      kind="tabs"
      id="test"
      panelId={(item) => `panel-${item}`}
      aria-label="Test"
      value={value}
      items={ITEMS}
      onValueChange={(item) => {
        onChange(item)
        setValue(item)
      }}
    />
  )
}

it('is a tablist with roving focus that skips disabled tabs', () => {
  const change = vi.fn()
  render(<Tabs onChange={change} />)
  const list = screen.getByRole('tablist', { name: 'Test' })
  const tabs = within(list).getAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
  expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1])
  expect(tabs[0].id).toBe('test-tab-a')
  expect(tabs[0].getAttribute('aria-controls')).toBe('panel-a')

  fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
  expect(change).toHaveBeenLastCalledWith('c')
  expect(tabs[2].getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(tabs[2])
  // Right from the last enabled tab wraps past the disabled one to the first.
  fireEvent.keyDown(tabs[2], { key: 'ArrowRight' })
  expect(document.activeElement).toBe(tabs[0])
  fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' })
  expect(document.activeElement).toBe(tabs[2])
  fireEvent.keyDown(tabs[2], { key: 'Home' })
  expect(document.activeElement).toBe(tabs[0])
  // End selects the last enabled tab.
  fireEvent.keyDown(tabs[0], { key: 'End' })
  expect(document.activeElement).toBe(tabs[2])
  expect(change.mock.calls.flat()).not.toContain('b')
  expect(change.mock.calls.flat()).not.toContain('d')
})

it('calls back for a click on the selected item', () => {
  const change = vi.fn()
  render(<Tabs onChange={change} />)
  fireEvent.click(screen.getByRole('tab', { name: 'Alpha' }))
  expect(change).toHaveBeenCalledWith('a')
})

it('is a group of pressed buttons that slides its glass on a change', () => {
  vi.useFakeTimers()
  vi.stubGlobal('PointerEvent', MouseEvent)
  const change = vi.fn()
  const { rerender } = render(
    <GlassGroup aria-label="Mode" value="a" items={ITEMS} onValueChange={change} />
  )
  const group = screen.getByRole('group', { name: 'Mode' })
  const buttons = within(group).getAllByRole('button')
  expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
    'true',
    'false',
    'false',
    'false'
  ])
  expect(buttons.every((button) => button.tabIndex === 0)).toBe(true)
  // The first paint does not slide, and a press turns the indicator to glass.
  expect(group.hasAttribute('data-moving')).toBe(false)
  fireEvent.pointerDown(buttons[2], { button: 0 })
  expect(group.hasAttribute('data-pressed')).toBe(true)
  fireEvent.pointerUp(window)
  fireEvent.click(buttons[2])
  expect(change).toHaveBeenCalledWith('c')
  rerender(<GlassGroup aria-label="Mode" value="c" items={ITEMS} onValueChange={change} />)
  expect(group.hasAttribute('data-moving')).toBe(true)
  act(() => vi.advanceTimersByTime(400))
  expect(group.hasAttribute('data-moving')).toBe(false)
  expect(group.hasAttribute('data-pressed')).toBe(false)
  // A press on a disabled item does nothing.
  fireEvent.pointerDown(buttons[1], { button: 0 })
  expect(group.hasAttribute('data-pressed')).toBe(false)
})

it('moves without the glass slide for reduced motion', () => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduced-motion') })
  })
  try {
    const { rerender } = render(
      <GlassGroup aria-label="Mode" value="a" items={ITEMS} onValueChange={() => {}} />
    )
    rerender(<GlassGroup aria-label="Mode" value="c" items={ITEMS} onValueChange={() => {}} />)
    expect(screen.getByRole('group').hasAttribute('data-moving')).toBe(false)
  } finally {
    Reflect.deleteProperty(window, 'matchMedia')
  }
})

it.each([
  ['the selected tab is disabled', 'x'],
  ['no tab is selected', 'none']
])('keeps the first enabled tab in the tab order when %s', (_, value) => {
  const items = [
    { value: 'x', label: 'X', disabled: true },
    { value: 'y', label: 'Y' },
    { value: 'z', label: 'Z' }
  ]
  render(
    <GlassGroup
      kind="tabs"
      id="t"
      panelId={(item) => item}
      aria-label="T"
      value={value}
      items={items}
      onValueChange={() => {}}
    />
  )
  expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toEqual([-1, 0, -1])
})

it('measures again when the group resizes or its layout props change', () => {
  let resize = (): void => {}
  const observed: Element[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe(element: Element): void {
        observed.push(element)
      }
      disconnect(): void {}
    }
  )
  const props = { 'aria-label': 'Mode', value: 'c', items: ITEMS, onValueChange: () => {} }
  const { rerender } = render(<GlassGroup {...props} />)
  const group = screen.getByRole('group')
  expect(observed).toContain(group)
  const indicator = group.querySelector<HTMLElement>('.glass-group-indicator')!
  const x = (): string => indicator.style.getPropertyValue('--glass-x')
  expect(x()).toBe('0px')
  // The item moves and keeps its size, as in a wider group with justify-between.
  const gamma = screen.getByRole('button', { name: 'Gamma' })
  Object.defineProperty(gamma, 'offsetLeft', { configurable: true, value: 40 })
  act(() => resize())
  expect(x()).toBe('40px')
  Object.defineProperty(gamma, 'offsetLeft', { configurable: true, value: 60 })
  rerender(<GlassGroup {...props} className="gap-4" />)
  expect(x()).toBe('60px')
})
