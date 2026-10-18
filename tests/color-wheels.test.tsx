// @vitest-environment jsdom
import { useState, type Dispatch, type SetStateAction } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_FILM, DEFAULT_WHEELS, defaultRecipe, type EditRecipe } from '@shared/editor'
import stocks from '@shared/film-stocks.json'
import { ColorWheels } from '../src/renderer/src/components/ColorWheels'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { t } from '../src/renderer/src/lib/strings'

const originalChange = editor.getState().change
const originalCommit = editor.getState().commit
const change = vi.fn()
const commit = vi.fn()
let setRecipe: Dispatch<SetStateAction<EditRecipe>>
function Wheels({ initial = defaultRecipe() }: { initial?: EditRecipe }): React.JSX.Element {
  const [recipe, update] = useState(initial)
  setRecipe = update
  return <ColorWheels recipe={recipe} />
}
// jsdom's PointerEvent drops the mouse fields. This one keeps them and the pointer id.
class TestPointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
  }
}
const wheels = (): EditRecipe['wheels'] => change.mock.lastCall?.[0].wheels
/** The wheel's disc, laid out as a 100 px square at the origin. */
function disc(name: string): HTMLElement {
  const element = screen.getByRole('application', { name: t(`editor.${name}`) })
  element.getBoundingClientRect = () => DOMRect.fromRect({ width: 100, height: 100 })
  return element
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  change
    .mockReset()
    .mockImplementation((patch: Partial<EditRecipe>) =>
      setRecipe((recipe) => ({ ...recipe, ...patch }))
    )
  commit.mockReset()
  queue.setState({ isProcessing: false, isPreparing: false })
  editor.setState({
    session: { sessionId: 'wheels', path: '/a.X3F', recipe: defaultRecipe(), revision: 0 },
    preview: { sessionId: 'wheels', revision: 0, url: 'preview', width: 1200, height: 800 },
    loading: false,
    closing: false,
    before: false,
    change,
    commit
  })
})
afterEach(() => {
  cleanup()
  editor.setState({ change: originalChange, commit: originalCommit, session: null, preview: null })
  vi.unstubAllGlobals()
})

it('drags the Midtones dot inside the disc, commits on release and resets it', () => {
  render(<Wheels />)
  const midtones = disc('midtones')
  fireEvent.pointerDown(midtones, { clientX: 80, clientY: 30, pointerId: 1, button: 0 })
  expect(change).toHaveBeenLastCalledWith(
    { wheels: expect.objectContaining({ midtones: { x: 0.6, y: 0.4, luminance: 0 } }) },
    false
  )
  // Past the rim, the dot stays on it.
  fireEvent.pointerMove(midtones, { clientX: 100, clientY: 0, pointerId: 1 })
  const { x, y } = wheels()!.midtones
  expect(x).toBeGreaterThan(0)
  expect(y).toBeGreaterThan(0)
  expect(Math.hypot(x, y)).toBeLessThanOrEqual(1)
  expect(commit).not.toHaveBeenCalled()
  fireEvent.pointerUp(midtones, { pointerId: 1 })
  expect(commit).toHaveBeenCalledTimes(1)
  expect(screen.getByText(/°, 100%$/)).toBeTruthy()
  fireEvent.click(
    screen.getByRole('button', { name: `${t('editor.resetWheel')}: ${t('editor.midtones')}` })
  )
  expect(wheels()!.midtones).toEqual({ x: 0, y: 0, luminance: 0 })
  expect(wheels()!.shadows).toEqual(DEFAULT_WHEELS.shadows)
})

it('keeps the hue with Shift, so a drag changes only the strength', () => {
  render(<Wheels />)
  const midtones = disc('midtones')
  // Red at the right of the center, at half strength.
  fireEvent.pointerDown(midtones, { clientX: 75, clientY: 50, pointerId: 1, button: 0 })
  expect(wheels()!.midtones).toMatchObject({ x: 0.5, y: 0 })
  // With Shift, a move up and to the right stays on the red line.
  fireEvent.pointerMove(midtones, { clientX: 90, clientY: 20, pointerId: 1, shiftKey: true })
  expect(wheels()!.midtones).toMatchObject({ x: 0.8, y: 0 })
  // Past the center, the dot stops at the center instead of taking the opposite hue.
  fireEvent.pointerMove(midtones, { clientX: 20, clientY: 40, pointerId: 1, shiftKey: true })
  expect(wheels()!.midtones).toMatchObject({ x: 0, y: 0 })
  // Without Shift, the hue follows the pointer again.
  fireEvent.pointerMove(midtones, { clientX: 50, clientY: 25, pointerId: 1 })
  expect(wheels()!.midtones).toMatchObject({ x: 0, y: 0.5 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
})

it('resets the color and the luminance of a wheel with its button', () => {
  render(<Wheels />)
  fireEvent.pointerDown(disc('shadows'), { clientX: 80, clientY: 30, pointerId: 1, button: 0 })
  fireEvent.pointerUp(disc('shadows'), { pointerId: 1 })
  fireEvent.keyDown(
    screen.getByRole('slider', { name: `${t('editor.shadows')} ${t('editor.luminance')}` }),
    { key: 'ArrowRight' }
  )
  expect(wheels()!.shadows.luminance).not.toBe(0)
  fireEvent.click(
    screen.getByRole('button', { name: `${t('editor.resetWheel')}: ${t('editor.shadows')}` })
  )
  expect(wheels()!.shadows).toEqual({ x: 0, y: 0, luminance: 0 })
})

it('drags only with the primary button of one pointer', () => {
  render(<Wheels />)
  const midtones = disc('midtones')
  fireEvent.pointerDown(midtones, { clientX: 80, clientY: 30, pointerId: 1, button: 2 })
  fireEvent.pointerDown(midtones, { clientX: 80, clientY: 30, pointerId: 1, ctrlKey: true })
  expect(change).not.toHaveBeenCalled()
  fireEvent.pointerDown(midtones, { clientX: 80, clientY: 30, pointerId: 1, button: 0 })
  expect(change).toHaveBeenCalledTimes(1)
  // A second pointer can neither take over nor end the drag.
  fireEvent.pointerDown(midtones, { clientX: 10, clientY: 10, pointerId: 2, button: 0 })
  fireEvent.pointerMove(midtones, { clientX: 10, clientY: 10, pointerId: 2 })
  fireEvent.pointerUp(midtones, { pointerId: 2 })
  expect(change).toHaveBeenCalledTimes(1)
  expect(commit).not.toHaveBeenCalled()
  fireEvent.pointerMove(midtones, { clientX: 70, clientY: 30, pointerId: 1 })
  expect(wheels()!.midtones).toEqual({ x: 0.4, y: 0.4, luminance: 0 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
  expect(commit).toHaveBeenCalledTimes(1)
})

it('ends a drag when the pointer capture is lost', () => {
  render(<Wheels />)
  const midtones = disc('midtones')
  fireEvent.pointerDown(midtones, { clientX: 80, clientY: 30, pointerId: 1, button: 0 })
  fireEvent.lostPointerCapture(midtones, { pointerId: 1 })
  expect(commit).toHaveBeenCalledTimes(1)
  change.mockClear()
  fireEvent.pointerMove(midtones, { clientX: 10, clientY: 10, pointerId: 1 })
  expect(change).not.toHaveBeenCalled()
})

it('ends a drag when the wheel turns off or unmounts', () => {
  const view = render(<Wheels />)
  fireEvent.pointerDown(disc('midtones'), { clientX: 80, clientY: 30, pointerId: 1, button: 0 })
  act(() => editor.setState({ closing: true }))
  expect(commit).toHaveBeenCalledTimes(1)
  act(() => editor.setState({ closing: false }))
  change.mockClear()
  fireEvent.pointerMove(disc('midtones'), { clientX: 10, clientY: 10, pointerId: 1 })
  expect(change).not.toHaveBeenCalled()
  fireEvent.pointerDown(disc('midtones'), { clientX: 80, clientY: 30, pointerId: 1, button: 0 })
  view.unmount()
  expect(commit).toHaveBeenCalledTimes(2)
})

it('nudges a dot with the arrow keys and writes Balance', () => {
  render(<Wheels />)
  fireEvent.keyDown(disc('shadows'), { key: 'ArrowRight' })
  expect(wheels()!.shadows).toEqual({ x: 0.02, y: 0, luminance: 0 })
  fireEvent.keyDown(disc('shadows'), { key: 'ArrowUp', shiftKey: true })
  expect(wheels()!.shadows).toEqual({ x: 0.02, y: 0.1, luminance: 0 })
  fireEvent.change(screen.getByRole('spinbutton', { name: t('editor.balance') }), {
    target: { value: '-40' }
  })
  expect(wheels()!.balance).toBe(-40)
  expect(wheels()!.shadows).toEqual({ x: 0.02, y: 0.1, luminance: 0 })
})

it('turns off only the hue discs for black-and-white looks', () => {
  const film = stocks.find((stock) => !stock.isPaper && stock.monochrome)!
  for (const initial of [
    { ...defaultRecipe(), monochrome: { filter: 'neutral' as const } },
    { ...defaultRecipe(), film: { ...DEFAULT_FILM, film: film.index } }
  ]) {
    const view = render(<Wheels initial={initial} />)
    expect(disc('highlights').getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(disc('highlights'), { key: 'ArrowLeft' })
    fireEvent.pointerDown(disc('highlights'), { clientX: 10, clientY: 10, pointerId: 1 })
    expect(change).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('spinbutton', { name: t('editor.blending') }), {
      target: { value: '20' }
    })
    expect(wheels()!.blending).toBe(20)
    expect(
      screen
        .getByRole('slider', { name: `${t('editor.highlights')} ${t('editor.luminance')}` })
        .hasAttribute('data-disabled')
    ).toBe(false)
    view.unmount()
    change.mockClear()
  }
})

it('ignores input while the editor is busy', () => {
  render(<Wheels />)
  act(() => editor.setState({ closing: true }))
  fireEvent.keyDown(disc('midtones'), { key: 'ArrowRight' })
  fireEvent.doubleClick(disc('midtones'))
  expect(change).not.toHaveBeenCalled()
  expect(
    screen
      .getByRole('slider', { name: `${t('editor.midtones')} ${t('editor.luminance')}` })
      .hasAttribute('data-disabled')
  ).toBe(true)
})
