// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AEROCHROME_MATRIX, defaultRecipe, type EditRecipe } from '@shared/editor'
import { RawMatrixControls } from '../src/renderer/src/components/RawColorControls'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { t } from '../src/renderer/src/lib/strings'
import { mixPadPoint } from '../src/renderer/src/lib/ternaryMix'

const original = editor.getState()
const invoke = vi.fn()
const path = '/ternary.X3F'
const initial: EditRecipe = {
  ...defaultRecipe(),
  cameraProfile: null,
  rawColor: { gains: [2, 1, 0.5], matrix: [...AEROCHROME_MATRIX] }
}
class TestPointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
  }
}
function Controls(): React.JSX.Element {
  const recipe = editor((state) => state.documents[path].recipe)
  return <RawMatrixControls recipe={recipe} />
}
const recipe = (): EditRecipe => editor.getState().documents[path].recipe
const row = (): number[] => recipe().rawColor!.matrix.slice(0, 3)
function pad(): HTMLElement {
  const element = screen.getByRole('application', { name: t('editor.mixPad') })
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 272 }) as DOMRect
  return element
}
const at = (x: number, y: number): { clientX: number; clientY: number } => {
  const p = mixPadPoint([
    (1 + 2 * y) / 3,
    (1 - y) / 3 - x / Math.sqrt(3),
    (1 - y) / 3 + x / Math.sqrt(3)
  ])
  return { clientX: (p.x + 8) * 20, clientY: (6.3 - p.y) * 20 }
}
const displayAt = (p: { x: number; y: number }): { clientX: number; clientY: number } => ({
  clientX: (p.x + 8) * 20,
  clientY: (6.3 - p.y) * 20
})
const field = (layer: string): HTMLInputElement =>
  screen.getByRole('spinbutton', { name: t(`editor.source${layer}`) })
function valid(): void {
  const values = row()
  expect(values.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12)
  for (const value of values) {
    expect(value).toBeGreaterThanOrEqual(-4)
    expect(value).toBeLessThanOrEqual(4)
  }
  expect(recipe().rawColor!.gains).toEqual(initial.rawColor!.gains)
  expect(recipe().rawColor!.matrix.slice(3)).toEqual(AEROCHROME_MATRIX.slice(3))
  expect(recipe().film).toEqual(initial.film)
}
beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  invoke.mockReset().mockImplementation(async (_command: string, payload: object) => ({
    ...payload,
    storage: 'sidecar'
  }))
  ;(window as unknown as { x3f: unknown }).x3f = { invoke, on: () => () => {} }
  queue.setState({ isPreparing: false, isProcessing: false })
  editor.setState({
    session: { sessionId: 'ternary', path, recipe: initial, revision: 0 },
    documents: { [path]: { recipe: initial, revision: 0, past: [], future: [], dirty: false } },
    preview: { sessionId: 'ternary' } as never,
    before: false,
    loading: false,
    closing: false,
    x3i: null,
    render: vi.fn()
  })
})
afterEach(async () => {
  cleanup()
  await editor.getState().flush()
  editor.setState(original, true)
  vi.unstubAllGlobals()
})

it('displays signed Aerochrome values without changing the recipe on load', () => {
  render(<Controls />)
  expect(
    screen.getByRole('img', { name: 'B: Bottom layer, M: Middle layer, T: Top layer' })
  ).toBeTruthy()
  expect(field('Bottom').value).toBe('170')
  expect(field('Middle').value).toBe('0')
  expect(field('Top').value).toBe('-70')
  fireEvent.click(screen.getByRole('tab', { name: t('editor.blue') }))
  expect(field('Bottom').value).toBe('50')
  expect(field('Middle').value).toBe('-350')
  expect(field('Top').value).toBe('400')
  const dot = pad().querySelector('[data-mix-point]')!
  const p = mixPadPoint([0.5, -3.5, 4])
  expect(dot.getAttribute('transform')).toBe(`translate(${p.x},${-p.y})`)
  expect(recipe()).toEqual(initial)
  expect(invoke).not.toHaveBeenCalled()
})

it('maps pointer positions, holds signed bounds, and saves one undo step for a drag', async () => {
  render(<Controls />)
  const element = pad()
  fireEvent.pointerDown(element, { ...at(0, 0), button: 0, pointerId: 1 })
  row().forEach((value) => expect(value).toBeCloseTo(1 / 3))
  fireEvent.pointerMove(element, { ...at(0, -2), pointerId: 2 })
  row().forEach((value) => expect(value).toBeCloseTo(1 / 3))
  fireEvent.pointerMove(element, { ...at(0, -2), pointerId: 1 })
  expect(row()[0]).toBeCloseTo(-1)
  valid()
  fireEvent.pointerMove(element, { ...at(100, 100), pointerId: 1 })
  valid()
  expect(editor.getState().documents[path].past).toHaveLength(0)
  expect(invoke).not.toHaveBeenCalled()
  fireEvent.pointerUp(element, { ...at(100, 100), pointerId: 1 })
  await act(async () => {
    await editor.getState().flush()
  })
  expect(editor.getState().documents[path].past).toHaveLength(1)
  expect(invoke.mock.calls.filter(([command]) => command === 'editor:save')).toHaveLength(1)
  const final = recipe()
  act(() => editor.getState().undo())
  expect(recipe()).toEqual(initial)
  act(() => editor.getState().redo())
  expect(recipe()).toEqual(final)
})

it('supports keyboard steps, fine steps, row reset and shortcut guards', () => {
  render(<Controls />)
  const element = pad()
  fireEvent.keyDown(element, { key: 'Delete' })
  expect(row()).toEqual([1, 0, 0])
  fireEvent.keyDown(element, { key: 'ArrowRight' })
  expect(row()[1]).toBeCloseTo(-0.01)
  expect(row()[2]).toBeCloseTo(0.01)
  fireEvent.keyDown(element, { key: 'ArrowUp', altKey: true })
  expect(row()[0]).toBeCloseTo(1.001)
  fireEvent.keyDown(element, { key: 'ArrowDown', shiftKey: true })
  expect(row()[0]).toBeCloseTo(0.901)
  valid()
  const before = recipe()
  fireEvent.keyDown(element, { key: 'ArrowRight', metaKey: true })
  expect(recipe()).toBe(before)
  fireEvent.click(screen.getByRole('button', { name: t('editor.resetOutputMix'), exact: true }))
  expect(row()).toEqual([1, 0, 0])
  valid()
})

it('allows signed numeric entry with proportional redistribution, then commits on blur', async () => {
  render(<Controls />)
  const input = field('Middle')
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: '' } })
  expect(recipe()).toEqual(initial)
  fireEvent.change(input, { target: { value: '-20.5' } })
  expect(row()[1]).toBe(-0.205)
  expect(row()[0] / row()[2]).toBeCloseTo(1.7 / -0.7)
  valid()
  expect(editor.getState().documents[path].past).toHaveLength(0)
  fireEvent.change(input, { target: { value: '800' } })
  expect(row()[1]).toBe(4)
  valid()
  fireEvent.blur(input)
  expect(input.value).toBe('400')
  await act(async () => {
    await editor.getState().flush()
  })
  expect(editor.getState().documents[path].past).toHaveLength(1)
})

it('ends capture on cancellation and ignores later moves or disabled interaction', () => {
  render(<Controls />)
  const element = pad()
  fireEvent.pointerDown(element, { ...at(0, 0), button: 2 })
  expect(recipe()).toEqual(initial)
  fireEvent.pointerDown(element, { ...at(0, 0), button: 0, pointerId: 1 })
  fireEvent.pointerCancel(element, { pointerId: 1 })
  expect(editor.getState().documents[path].past).toHaveLength(1)
  const before = recipe()
  fireEvent.pointerMove(element, { ...at(3, 2), pointerId: 1 })
  expect(recipe()).toBe(before)
  act(() => editor.setState({ before: true }))
  fireEvent.pointerDown(element, { ...at(3, 2), button: 0, pointerId: 1 })
  fireEvent.keyDown(element, { key: 'Delete' })
  expect(recipe()).toBe(before)
})

it('supports a fine pointer drag and ends a live drag when the pad unmounts', () => {
  const view = render(<Controls />)
  const element = pad()
  fireEvent.keyDown(element, { key: 'Delete' })
  fireEvent.pointerDown(element, { ...at(0, 0), button: 0, pointerId: 1 })
  fireEvent.pointerMove(element, { ...at(Math.sqrt(3) * 0.1, 0), pointerId: 1, altKey: true })
  expect(row()[1]).toBeCloseTo(1 / 3 - 0.01)
  expect(row()[2]).toBeCloseTo(1 / 3 + 0.01)
  view.unmount()
  expect(editor.getState().documents[path].gesture).toBeUndefined()
})

it('returns to the same mix after dragging past a boundary and back', () => {
  render(<Controls />)
  const element = pad()
  fireEvent.pointerDown(element, { ...at(0, 0), button: 0, pointerId: 1 })
  fireEvent.pointerMove(element, { ...at(100, 100), pointerId: 1 })
  valid()
  fireEvent.pointerMove(element, { ...at(0, 0), pointerId: 1 })
  row().forEach((value) => expect(value).toBeCloseTo(1 / 3))
  fireEvent.pointerUp(element, { ...at(0, 0), pointerId: 1 })
})

it('clears a numeric draft and closes its gesture if the editor becomes disabled', () => {
  render(<Controls />)
  const input = field('Middle')
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: '800' } })
  expect(input.value).toBe('800')
  act(() => editor.setState({ loading: true }))
  expect(input.disabled).toBe(true)
  expect(input.value).toBe('400')
  expect(editor.getState().documents[path].gesture).toBeUndefined()
})

it('does not commit another control gesture when unfocused fields become disabled', () => {
  render(<Controls />)
  act(() => editor.getState().change({ exposure: 1 }, false))
  act(() => queue.setState({ isPreparing: true }))
  expect(editor.getState().documents[path].gesture).toBeTruthy()
  expect(editor.getState().documents[path].past).toHaveLength(0)
})

it('ends a pad drag on disable and ignores later pointer moves', () => {
  render(<Controls />)
  const element = pad()
  fireEvent.pointerDown(element, { ...at(0, 0), button: 0, pointerId: 1 })
  act(() => editor.setState({ loading: true }))
  expect(editor.getState().documents[path].gesture).toBeUndefined()
  expect(editor.getState().documents[path].past).toHaveLength(1)
  const before = recipe()
  fireEvent.pointerMove(element, { ...at(3, 2), pointerId: 1 })
  expect(recipe()).toBe(before)
})

it('resets the selected output on a point double-click', () => {
  render(<Controls />)
  fireEvent.click(screen.getByRole('tab', { name: t('editor.blue') }))
  const point = mixPadPoint([0.5, -3.5, 4])
  fireEvent.doubleClick(pad(), displayAt(point))
  expect(recipe().rawColor!.matrix.slice(6)).toEqual([0, 0, 1])
  expect(recipe().rawColor!.matrix.slice(0, 6)).toEqual(AEROCHROME_MATRIX.slice(0, 6))
})

it('switches between pad and sliders without changing signed mixes or history', () => {
  render(<Controls />)
  const sliders = screen.getByRole('button', { name: t('editor.mixSlidersView') })
  fireEvent.click(sliders)
  expect(sliders.getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByRole('application', { name: t('editor.mixPad') })).toBeNull()
  for (const layer of ['Bottom', 'Middle', 'Top'])
    expect(screen.getByRole('slider', { name: t(`editor.source${layer}`) })).toBeTruthy()
  expect(recipe()).toEqual(initial)
  fireEvent.click(screen.getByRole('tab', { name: t('editor.blue') }))
  expect(field('Bottom').value).toBe('50')
  expect(field('Middle').value).toBe('-350')
  expect(field('Top').value).toBe('400')
  fireEvent.click(screen.getByRole('button', { name: t('editor.mixPadView') }))
  expect(screen.queryByRole('slider', { name: t('editor.sourceBottom') })).toBeNull()
  expect(pad()).toBeTruthy()
  expect(recipe()).toEqual(initial)
  expect(editor.getState().documents[path].past).toHaveLength(0)
  expect(invoke).not.toHaveBeenCalled()
})

it('shares proportional slider edits with the pad and retains Undo across view changes', () => {
  render(<Controls />)
  fireEvent.click(screen.getByRole('button', { name: t('editor.mixSlidersView') }))
  fireEvent.change(field('Middle'), { target: { value: '-20' } })
  expect(row()[1]).toBe(-0.2)
  expect(row()[0] / row()[2]).toBeCloseTo(1.7 / -0.7)
  valid()
  const edited = recipe()
  fireEvent.click(screen.getByRole('button', { name: t('editor.mixPadView') }))
  expect(recipe()).toBe(edited)
  expect(field('Middle').value).toBe('-20')
  act(() => editor.getState().undo())
  expect(recipe()).toEqual(initial)
  act(() => editor.getState().redo())
  expect(recipe()).toEqual(edited)
})

it('commits a live pad drag once before switching to sliders', () => {
  render(<Controls />)
  fireEvent.pointerDown(pad(), { ...at(0, 0), button: 0, pointerId: 1 })
  expect(editor.getState().documents[path].past).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: t('editor.mixSlidersView') }))
  expect(editor.getState().documents[path].past).toHaveLength(1)
  expect(editor.getState().documents[path].gesture).toBeUndefined()
  row().forEach((value) => expect(value).toBeCloseTo(1 / 3))
  valid()
  act(() => editor.getState().undo())
  expect(recipe()).toEqual(initial)
})

it('uses the prior slider keyboard and reset controls with a 100% row total', () => {
  render(<Controls />)
  fireEvent.click(screen.getByRole('button', { name: t('editor.mixSlidersView') }))
  const slider = screen.getByRole('slider', { name: t('editor.sourceBottom') })
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  expect(row()[0]).toBeCloseTo(1.71)
  valid()
  fireEvent.doubleClick(slider)
  expect(row()[0]).toBe(1)
  valid()
})

it('does not rewrite the mix when pressing and releasing the handle without moving', () => {
  render(<Controls />)
  const element = pad()
  const handle = element.querySelector('[data-mix-point]')!
  const p = displayAt(mixPadPoint([1.7, 0, -0.7]))
  fireEvent.pointerDown(handle, { ...p, button: 0, pointerId: 1 })
  fireEvent.pointerUp(handle, { ...p, pointerId: 1 })
  expect(recipe()).toBe(initial)
  expect(editor.getState().documents[path].past).toHaveLength(0)
  expect(invoke).not.toHaveBeenCalled()
})

it('arms the qualifier for the selected output and disarms it on output or view changes', () => {
  function QualifiedControls(): React.JSX.Element {
    const [target, setTarget] = useState<0 | 1 | 2 | null>(null)
    return <RawMatrixControls recipe={initial} mixPicking={target} setMixPicking={setTarget} />
  }
  render(<QualifiedControls />)
  const red = screen.getByRole('button', {
    name: t('editor.mixQualifier', { color: t('editor.red') })
  })
  fireEvent.click(red)
  expect(red.getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('status').textContent).toContain(t('editor.red'))
  fireEvent.click(screen.getByRole('tab', { name: t('editor.blue') }))
  const blue = screen.getByRole('button', {
    name: t('editor.mixQualifier', { color: t('editor.blue') })
  })
  expect(blue.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(blue)
  expect(blue.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: t('editor.mixSlidersView') }))
  fireEvent.click(screen.getByRole('button', { name: t('editor.mixPadView') }))
  expect(
    screen
      .getByRole('button', { name: t('editor.mixQualifier', { color: t('editor.blue') }) })
      .getAttribute('aria-pressed')
  ).toBe('false')
})
