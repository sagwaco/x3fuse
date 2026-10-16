// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NativeMenuButton } from '../src/renderer/src/components/ui/nativeMenuButton'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('anchors the OS menu, prevents duplicate opens, and ignores cancelled or disabled results', async () => {
  const onSelect = vi.fn()
  let choose!: (value: string | null) => void
  invoke.mockImplementation(async (channel) =>
    channel === 'menu:popup'
      ? new Promise((resolve) => {
          choose = resolve
        })
      : undefined
  )
  const items = [
    { value: 'a', label: 'A', checked: true },
    { value: 'b', label: 'B', disabled: true }
  ]
  render(
    <NativeMenuButton items={items} onSelect={onSelect}>
      Format
    </NativeMenuButton>
  )
  const button = screen.getByRole('button', { name: 'Format' })
  button.getBoundingClientRect = () => ({ left: 20, bottom: 64 }) as DOMRect
  fireEvent.click(button)
  fireEvent.keyDown(button, { key: 'ArrowDown' })
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith('menu:popup', { id: expect.any(String), x: 20, y: 64, items })
  await act(async () => choose(null))
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.keyDown(button, { key: 'Enter' })
  await act(async () => choose('b'))
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.keyDown(button, { key: ' ' })
  await act(async () => choose('a'))
  expect(onSelect).toHaveBeenCalledTimes(1)
  expect(onSelect).toHaveBeenCalledWith('a')
  expect(button.getAttribute('aria-expanded')).toBe('false')
})

it('cancels on unmount and never opens a disabled fieldset control', async () => {
  let choose!: (value: string) => void
  invoke.mockImplementation(async (channel) =>
    channel === 'menu:popup'
      ? new Promise((resolve) => {
          choose = resolve
        })
      : undefined
  )
  const onSelect = vi.fn()
  const control = (
    <NativeMenuButton items={[{ value: 'a', label: 'A' }]} onSelect={onSelect}>
      Format
    </NativeMenuButton>
  )
  const view = render(<fieldset disabled>{control}</fieldset>)
  fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowDown' })
  expect(invoke).not.toHaveBeenCalled()
  view.rerender(<fieldset>{control}</fieldset>)
  fireEvent.click(screen.getByRole('button'))
  const id = invoke.mock.calls[0][1].id
  view.unmount()
  expect(invoke).toHaveBeenCalledWith('menu:close', id)
  await act(async () => choose('a'))
  expect(onSelect).not.toHaveBeenCalled()
})

it('uses current callbacks and options when an open menu finishes after a rerender', async () => {
  let choose!: (value: string) => void
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        choose = resolve
      })
  )
  const oldSelect = vi.fn()
  const nextSelect = vi.fn()
  const items = [{ value: 'a', label: 'A' }]
  const view = render(
    <NativeMenuButton items={items} onSelect={oldSelect}>
      Format
    </NativeMenuButton>
  )
  fireEvent.click(screen.getByRole('button'))
  view.rerender(
    <NativeMenuButton items={items} onSelect={nextSelect}>
      Format
    </NativeMenuButton>
  )
  await act(async () => choose('a'))
  expect(oldSelect).not.toHaveBeenCalled()
  expect(nextSelect).toHaveBeenCalledWith('a')
  fireEvent.click(screen.getByRole('button'))
  view.rerender(
    <NativeMenuButton items={[{ ...items[0], disabled: true }]} onSelect={nextSelect}>
      Format
    </NativeMenuButton>
  )
  await act(async () => choose('a'))
  expect(nextSelect).toHaveBeenCalledOnce()
})
