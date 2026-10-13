// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useToolbarSwap } from '../src/renderer/src/hooks/useToolbarSwap'

function Bar({ target }: { target: boolean }): JSX.Element {
  const { ref, shown, leaving } = useToolbarSwap(target)
  return (
    <div ref={ref}>
      <div data-swap {...(leaving ? { inert: '' } : {})} data-mode={shown ? 'crop' : 'edit'}>
        {shown ? <button>Apply</button> : <button>Crop</button>}
        {shown ? <button>Cancel</button> : <button>Copy</button>}
      </div>
    </div>
  )
}

type Fake = { element: Element; finish: () => void; cancel: ReturnType<typeof vi.fn> }
let animations: Fake[] = []
let reduced = false

beforeEach(() => {
  animations = []
  reduced = false
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }))
  vi.stubGlobal('CSS', { supports: () => true })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // @ts-expect-error test cleanup of the mock
  delete Element.prototype.animate
  // @ts-expect-error test cleanup of the mock
  delete Element.prototype.getAnimations
})

function mockAnimate(): void {
  Element.prototype.getAnimations = function () {
    return animations
      .filter((a) => a.element === this && !a.cancel.mock.calls.length)
      .map((a) => ({ cancel: a.cancel }) as unknown as Animation)
  }
  Element.prototype.animate = function () {
    let finish = (): void => {}
    let fail = (): void => {}
    const finished = new Promise<void>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    finished.catch(() => undefined)
    const fake: Fake = { element: this, finish, cancel: vi.fn(fail) }
    animations.push(fake)
    return { finished, cancel: fake.cancel } as unknown as Animation
  }
}

const mode = (c: HTMLElement): string | null =>
  c.querySelector('[data-swap]')!.getAttribute('data-mode')

/** Render the edit toolbar and drop its entrance animations. */
function mount(): ReturnType<typeof render> {
  const view = render(<Bar target={false} />)
  animations = []
  return view
}

it('scales the buttons in when the toolbar mounts', () => {
  mockAnimate()
  render(<Bar target={false} />)
  expect(animations.map((a) => a.element.textContent)).toEqual(['Crop', 'Copy'])
})

it('swaps at once without animation support', () => {
  const view = render(<Bar target={false} />)
  view.rerender(<Bar target />)
  expect(mode(view.container)).toBe('crop')
})

it('swaps at once for reduced motion', () => {
  mockAnimate()
  reduced = true
  const view = render(<Bar target={false} />)
  view.rerender(<Bar target />)
  expect(mode(view.container)).toBe('crop')
  expect(animations).toHaveLength(0)
})

it('keeps the old buttons inert until the exit ends, then scales the new ones in', async () => {
  mockAnimate()
  const view = mount()
  view.rerender(<Bar target />)
  expect(mode(view.container)).toBe('edit')
  expect(view.container.querySelector('[data-swap]')!.hasAttribute('inert')).toBe(true)
  expect(animations).toHaveLength(2)
  await act(async () => animations.forEach((a) => a.finish()))
  expect(mode(view.container)).toBe('crop')
  expect(view.container.querySelector('[data-swap]')!.hasAttribute('inert')).toBe(false)
  // Two more animations: the buttons scaling in.
  expect(animations).toHaveLength(4)
})

it('ends on the latest state after a rapid toggle', async () => {
  mockAnimate()
  const view = mount()
  view.rerender(<Bar target />)
  view.rerender(<Bar target={false} />)
  // The exit was cancelled, so the first toolbar stays and is usable again.
  expect(animations[0].cancel).toHaveBeenCalled()
  expect(mode(view.container)).toBe('edit')
  expect(view.container.querySelector('[data-swap]')!.hasAttribute('inert')).toBe(false)
  await act(async () => animations.forEach((a) => a.finish()))
  expect(mode(view.container)).toBe('edit')
  expect(view.container.querySelectorAll('button')).toHaveLength(2)
})

it('stops a bounce in flight when the toolbar reverses', async () => {
  mockAnimate()
  const view = mount()
  view.rerender(<Bar target />)
  await act(async () => animations.forEach((a) => a.finish()))
  const entering = animations.slice(2)
  expect(entering).toHaveLength(2)
  view.rerender(<Bar target={false} />)
  entering.forEach((a) => expect(a.cancel).toHaveBeenCalled())
  await act(async () => animations.slice(4).forEach((a) => a.finish()))
  expect(mode(view.container)).toBe('edit')
})
