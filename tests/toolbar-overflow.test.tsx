// @vitest-environment jsdom
import { useRef } from 'react'
import { Copy, Crop, Upload } from 'lucide-react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useToolbarOverflow } from '../src/renderer/src/hooks/useToolbarOverflow'
import { OverflowMenu, type OverflowAction } from '../src/renderer/src/components/ui/overflowMenu'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

const ORDER = ['copy', 'crop', 'export']

function Bar({ onSelect }: { onSelect: (id: string, value?: string) => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const hidden = new Set(ORDER.slice(0, useToolbarOverflow(ref, ORDER.length)))
  const action = (id: string, icon: OverflowAction['icon'], extra = {}): OverflowAction => ({
    id,
    label: id,
    icon,
    onSelect: (value) => onSelect(id, value),
    ...extra
  })
  const actions = [
    action('copy', Copy, { pressed: true }),
    action('crop', Crop, { disabled: true }),
    action('export', Upload, { items: [{ value: 'jpeg', label: 'JPEG' }] })
  ]
  return (
    <div ref={ref}>
      {actions
        .filter((a) => !hidden.has(a.id))
        .map((a) => (
          <button key={a.id}>{a.label}</button>
        ))}
      <OverflowMenu actions={actions.filter((a) => hidden.has(a.id))} />
    </div>
  )
}

it('folds buttons in order until the toolbar fits, and keeps their states in the menu', async () => {
  // Every button is 100 px wide, and the toolbar is 250 px wide.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(250)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.tagName === 'BUTTON' ? 100 : this.querySelectorAll('button').length * 100
  })
  const onSelect = vi.fn()
  render(<Bar onSelect={onSelect} />)
  // Two buttons and the menu button would be 300 px, so two buttons fold.
  expect(screen.queryByRole('button', { name: 'copy' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'crop' })).toBeNull()
  expect(screen.getByRole('button', { name: 'export' })).toBeTruthy()
  invoke.mockImplementation(async () => 'export:jpeg')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'More actions' })))
  const items = invoke.mock.calls[0][1].items
  expect(items).toMatchObject([
    { value: 'copy', checked: true, icon: Copy },
    { value: 'crop', disabled: true, icon: Crop }
  ])
  expect(items).toHaveLength(2)
  expect(onSelect).not.toHaveBeenCalled()
})

it('observes content size changes and returns buttons when the content shrinks', async () => {
  let width = 100
  let notify!: () => void
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notify = callback
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(350)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.tagName === 'BUTTON' ? width : this.querySelectorAll('button').length * width
  })
  render(<Bar onSelect={vi.fn()} />)
  // Three buttons of 100 px fit 350 px.
  expect(screen.getByRole('button', { name: 'copy' })).toBeTruthy()
  // Content grows without a render of the parent.
  width = 150
  await act(async () => notify())
  expect(screen.queryByRole('button', { name: 'copy' })).toBeNull()
  // Content shrinks at the same toolbar width.
  width = 100
  await act(async () => notify())
  expect(screen.getByRole('button', { name: 'copy' })).toBeTruthy()
  vi.unstubAllGlobals()
})

it('waits for the swap animation before it folds', async () => {
  // A scaled button adds to the scroll width, so a fold during the animation would undo itself.
  let finish!: () => void
  const finished = new Promise<void>((resolve) => (finish = resolve))
  const animations = [{ playState: 'running', finished }] as unknown as Animation[]
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => animations
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(250)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.tagName === 'BUTTON' ? 100 : this.querySelectorAll('button').length * 100
  })
  try {
    render(<Bar onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'copy' })).toBeTruthy()
    animations.length = 0
    await act(async () => finish())
    expect(screen.queryByRole('button', { name: 'copy' })).toBeNull()
  } finally {
    delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
  }
})
