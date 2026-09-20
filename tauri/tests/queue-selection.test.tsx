// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useQueueSelection } from '../src/renderer/src/hooks/useQueueSelection'
import type { ArrowNav } from '../src/renderer/src/lib/queueNavigation'
import { useQueueStore } from '../src/renderer/src/stores/queueStore'

const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
  id,
  path: `/photos/${id}.X3F`,
  fileName: `${id}.X3F`
}))

function Surface({ ordered = files, nav }: { ordered?: typeof files; nav: ArrowNav }) {
  const selection = useQueueSelection(ordered, nav)
  return <div tabIndex={0} onKeyDown={selection.handleKeyDown} data-testid="surface" />
}

beforeEach(() => {
  useQueueStore.setState({ files, selectedIds: new Set(['a']), activeId: 'a', draft: null })
})
afterEach(cleanup)

it.each([
  ['list', { mode: 'vertical' }, 'ArrowDown', 'b', 'c'],
  ['grid', { mode: 'grid', columns: 2 }, 'ArrowDown', 'c', 'e'],
  ['filmstrip', { mode: 'horizontal' }, 'ArrowRight', 'b', 'c']
] as const)(
  'recovers %s navigation after background focus loss, without double movement',
  (_mode, nav, key, next, afterNext) => {
    const view = render(<Surface nav={nav} />)
    const surface = view.getByTestId('surface')
    surface.focus()
    surface.blur()
    expect(document.activeElement).toBe(document.body)
    expect(fireEvent.keyDown(document.body, { key })).toBe(false)
    expect(useQueueStore.getState().activeId).toBe(next)
    surface.focus()
    fireEvent.keyDown(surface, { key })
    expect(useQueueStore.getState().activeId).toBe(afterNext)
  }
)

it('retains the Shift anchor and uses updated ordering and grid dimensions', () => {
  const view = render(<Surface nav={{ mode: 'grid', columns: 2 }} />)
  fireEvent.keyDown(document.body, { key: 'ArrowDown', shiftKey: true })
  expect(useQueueStore.getState().selectedIds).toEqual(new Set(['a', 'b', 'c']))
  view.rerender(<Surface ordered={[...files].reverse()} nav={{ mode: 'grid', columns: 3 }} />)
  fireEvent.keyDown(document.body, { key: 'ArrowUp', shiftKey: true })
  expect(useQueueStore.getState().activeId).toBe('f')
  expect(useQueueStore.getState().selectedIds).toEqual(new Set(files.map((file) => file.id)))
  fireEvent.keyDown(document.body, { key: 'ArrowUp' })
  expect(useQueueStore.getState().activeId).toBe('f')
})

it('replaces its listener on view switches and removes it on unmount', () => {
  const view = render(<Surface key="list" nav={{ mode: 'vertical' }} />)
  view.rerender(<Surface key="filmstrip" nav={{ mode: 'horizontal' }} />)
  expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(true)
  expect(useQueueStore.getState().activeId).toBe('a')
  fireEvent.keyDown(document.body, { key: 'ArrowRight' })
  expect(useQueueStore.getState().activeId).toBe('b')
  view.unmount()
  expect(fireEvent.keyDown(document.body, { key: 'ArrowRight' })).toBe(true)
  expect(useQueueStore.getState().activeId).toBe('b')
})

it('leaves focused controls and editable content alone', () => {
  const view = render(
    <>
      <Surface nav={{ mode: 'vertical' }} />
      <button>Toolbar</button>
      <input />
      <textarea />
      <select>
        <option>One</option>
      </select>
      <div contentEditable tabIndex={0} />
      <div role="slider" tabIndex={0} />
      <div role="region" tabIndex={0} />
    </>
  )
  for (const control of view.container.querySelectorAll<HTMLElement>(
    'button, input, textarea, select, [contenteditable], [role]'
  )) {
    control.focus()
    expect(document.activeElement).toBe(control)
    expect(fireEvent.keyDown(control, { key: 'ArrowDown' })).toBe(true)
    // A background-targeted event must not bypass the focused-control guard.
    expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(true)
    expect(useQueueStore.getState().activeId).toBe('a')
  }
})

it.each(['dialog', 'menu', 'native menu'])(
  'leaves background arrows alone while a %s is open',
  (overlay) => {
    render(
      <>
        <Surface nav={{ mode: 'vertical' }} />
        {overlay === 'native menu' ? (
          <button aria-haspopup="menu" aria-expanded="true">
            Menu
          </button>
        ) : (
          <div role={overlay} data-state="open" />
        )}
      </>
    )
    expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(true)
    expect(useQueueStore.getState().activeId).toBe('a')
  }
)

it('ignores handled keys, background deletion, unsupported arrows, and an empty view', () => {
  const view = render(<Surface nav={{ mode: 'vertical' }} />)
  const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
  event.preventDefault()
  fireEvent(document.body, event)
  for (const key of ['Delete', 'Backspace', 'ArrowRight']) {
    expect(fireEvent.keyDown(document.body, { key })).toBe(true)
  }
  expect(useQueueStore.getState().activeId).toBe('a')
  expect(useQueueStore.getState().files).toEqual(files)
  view.rerender(<Surface ordered={[]} nav={{ mode: 'vertical' }} />)
  expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(true)
  expect(useQueueStore.getState().activeId).toBe('a')
})
