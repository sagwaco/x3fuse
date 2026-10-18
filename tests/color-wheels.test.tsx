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
import { appInfo } from '../src/renderer/src/lib/appInfo'

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
  appInfo.platform = 'linux'
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

/** The knob of a wheel. Its events reach the disc, which measures them. */
const knob = (name: string, which: 'inner' | 'outer'): HTMLElement =>
  disc(name).querySelector<HTMLElement>(`[data-knob="${which}"]`)!
const description = (name: string): string =>
  document.getElementById(disc(name).getAttribute('aria-describedby')!)!.textContent!

it('keeps the hue on a press of the inner knob until the pointer leaves its line', () => {
  const view = render(<Wheels />)
  const midtones = disc('midtones')
  fireEvent.pointerDown(midtones, { clientX: 75, clientY: 50, pointerId: 1, button: 0 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
  // A press on the knob does not move it. A drag near the hue line changes only the strength.
  fireEvent.pointerDown(knob('midtones', 'inner'), { clientX: 77, clientY: 50, pointerId: 1 })
  expect(wheels()!.midtones).toMatchObject({ x: 0.5, y: 0 })
  fireEvent.pointerMove(midtones, { clientX: 87, clientY: 54, pointerId: 1 })
  expect(wheels()!.midtones).toMatchObject({ x: 0.7, y: 0 })
  expect(view.container.querySelector('.origin-left')).not.toBeNull()
  // Far from the line, the lock lets go for the rest of the drag.
  fireEvent.pointerMove(midtones, { clientX: 77, clientY: 20, pointerId: 1 })
  expect(wheels()!.midtones).toMatchObject({ x: 0.5, y: 0.6 })
  expect(view.container.querySelector('.origin-left')).toBeNull()
  fireEvent.pointerUp(midtones, { pointerId: 1 })
})

it('turns only the hue with the outer knob, and keeps the hue at zero strength', () => {
  render(<Wheels />)
  const midtones = disc('midtones')
  fireEvent.pointerDown(midtones, { clientX: 75, clientY: 50, pointerId: 1, button: 0 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
  // The outer knob is on the rim at the hue. A drag to the top turns the hue to 90°.
  fireEvent.pointerDown(knob('midtones', 'outer'), { clientX: 100, clientY: 50, pointerId: 1 })
  fireEvent.pointerMove(midtones, { clientX: 50, clientY: 0, pointerId: 1 })
  expect(wheels()!.midtones).toMatchObject({ x: 0, y: 0.5 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
  // A double-click on the inner knob resets the strength, and the hue stays.
  fireEvent.doubleClick(knob('midtones', 'inner'))
  expect(wheels()!.midtones).toMatchObject({ x: 0, y: 0 })
  expect(description('midtones')).toMatch(/ 90°, 0%$/)
  // A double-click on the outer knob resets the hue.
  fireEvent.doubleClick(knob('midtones', 'outer'))
  expect(description('midtones')).toMatch(/ 0°, 0%$/)
})

it('lets Control turn the hue of the pressed inner knob, past its soft lock', () => {
  render(<Wheels />)
  const midtones = disc('midtones')
  fireEvent.pointerDown(midtones, { clientX: 75, clientY: 50, pointerId: 1, button: 0 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
  fireEvent.pointerDown(knob('midtones', 'inner'), { clientX: 75, clientY: 50, pointerId: 1 })
  // Closer to the hue line than the soft lock reaches, Control still turns the hue.
  fireEvent.pointerMove(midtones, { clientX: 75, clientY: 58, pointerId: 1, ctrlKey: true })
  const { x, y } = wheels()!.midtones
  expect(y).toBeLessThan(-0.1)
  expect(Math.hypot(x, y)).toBeCloseTo(0.5, 3)
  fireEvent.pointerUp(midtones, { pointerId: 1 })
})

it('takes the outer knob outside the rim where the knobs overlap', () => {
  render(<Wheels />)
  const midtones = disc('midtones')
  fireEvent.pointerDown(midtones, { clientX: 100, clientY: 50, pointerId: 1, button: 0 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
  expect(wheels()!.midtones).toMatchObject({ x: 1, y: 0 })
  // Outside the rim: the outer knob turns the hue and keeps the strength.
  fireEvent.pointerDown(knob('midtones', 'inner'), { clientX: 102, clientY: 50, pointerId: 1 })
  fireEvent.pointerMove(midtones, { clientX: 52, clientY: 0, pointerId: 1 })
  expect(wheels()!.midtones).toMatchObject({ x: 0, y: 1 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
  // Inside the rim: the inner knob, with its soft lock.
  fireEvent.pointerDown(knob('midtones', 'outer'), { clientX: 50, clientY: 3, pointerId: 1 })
  fireEvent.pointerMove(midtones, { clientX: 52, clientY: 28, pointerId: 1 })
  expect(wheels()!.midtones).toMatchObject({ x: 0, y: 0.5 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
})

it('locks the saturation with Control, and moves less with Alt', () => {
  render(<Wheels />)
  const midtones = disc('midtones')
  fireEvent.pointerDown(midtones, { clientX: 75, clientY: 50, pointerId: 1, button: 0 })
  fireEvent.pointerMove(midtones, { clientX: 50, clientY: 0, pointerId: 1, ctrlKey: true })
  expect(wheels()!.midtones).toMatchObject({ x: 0, y: 0.5 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
  // Fine adjust: 20 px of pointer movement moves the knob 5 px.
  fireEvent.pointerDown(knob('midtones', 'inner'), { clientX: 50, clientY: 25, pointerId: 1 })
  fireEvent.pointerMove(midtones, { clientX: 70, clientY: 25, pointerId: 1, altKey: true })
  expect(wheels()!.midtones).toMatchObject({ x: 0.1, y: 0.5 })
  fireEvent.pointerUp(midtones, { pointerId: 1 })
})

it('resets, copies and pastes wheels from the context menu', async () => {
  let choice = 'copy'
  const invoke = vi.fn(async (channel: string) => (channel === 'menu:popup' ? choice : null))
  vi.stubGlobal('x3f', { invoke, on: () => () => {} })
  render(<Wheels />)
  fireEvent.pointerDown(disc('shadows'), { clientX: 75, clientY: 50, pointerId: 1, button: 0 })
  fireEvent.pointerUp(disc('shadows'), { pointerId: 1 })
  await act(async () => {
    fireEvent.contextMenu(disc('shadows'), { clientX: 10, clientY: 20 })
  })
  expect(invoke).toHaveBeenLastCalledWith(
    'menu:popup',
    expect.objectContaining({
      x: 10,
      y: 20,
      items: [
        expect.objectContaining({ value: 'reset', label: t('editor.resetWheel') }),
        expect.objectContaining({ value: 'resetAll', label: t('editor.resetWheels') }),
        expect.objectContaining({ value: 'copy', label: t('editor.copyWheel') }),
        expect.objectContaining({ value: 'paste', label: t('editor.pasteWheel') })
      ]
    })
  )
  choice = 'paste'
  await act(async () => {
    fireEvent.contextMenu(disc('highlights'), { clientX: 10, clientY: 20 })
  })
  expect(wheels()!.highlights).toEqual({ x: 0.5, y: 0, luminance: 0 })
  choice = 'resetAll'
  await act(async () => {
    fireEvent.contextMenu(disc('highlights'), { clientX: 10, clientY: 20 })
  })
  expect(wheels()!.shadows).toEqual(DEFAULT_WHEELS.shadows)
  expect(wheels()!.highlights).toEqual(DEFAULT_WHEELS.highlights)
})

it('drags only with the primary button of one pointer', () => {
  // Control-click is a secondary click on macOS. Elsewhere, Control locks the saturation.
  appInfo.platform = 'darwin'
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

it('turns the hue and changes the strength with the keys, and writes Balance', () => {
  render(<Wheels />)
  // At zero strength, the wheel keeps the hue that the keys turn to.
  fireEvent.keyDown(disc('shadows'), { key: 'ArrowRight', shiftKey: true })
  expect(wheels()!.shadows).toEqual({ x: 0, y: 0, luminance: 0, hue: 0.1745 })
  expect(description('shadows')).toMatch(/ 10°, 0%$/)
  fireEvent.keyDown(disc('shadows'), { key: 'ArrowUp', shiftKey: true })
  expect(wheels()!.shadows).toEqual({ x: 0.0985, y: 0.0174, luminance: 0 })
  // Delete resets the strength and keeps the hue. Shift+Delete resets the hue.
  fireEvent.keyDown(disc('shadows'), { key: 'Delete' })
  expect(wheels()!.shadows).toMatchObject({ x: 0, y: 0, luminance: 0 })
  expect(wheels()!.shadows.hue).toBeCloseTo(0.1745, 2)
  fireEvent.keyDown(disc('shadows'), { key: 'Delete', shiftKey: true })
  expect(wheels()!.shadows).toEqual({ x: 0, y: 0, luminance: 0 })
  fireEvent.keyDown(disc('shadows'), { key: 'ArrowUp' })
  fireEvent.change(screen.getByRole('spinbutton', { name: t('editor.balance') }), {
    target: { value: '-40' }
  })
  expect(wheels()!.balance).toBe(-40)
  expect(wheels()!.shadows).toEqual({ x: 0.02, y: 0, luminance: 0 })
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
