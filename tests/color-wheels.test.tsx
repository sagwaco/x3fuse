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
const wheels = (): EditRecipe['wheels'] => change.mock.lastCall?.[0].wheels
const disc = (name: string): HTMLElement =>
  screen.getByRole('application', { name: t(`editor.${name}`) })

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  // jsdom's PointerEvent drops clientX and clientY.
  vi.stubGlobal('PointerEvent', MouseEvent)
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
  vi.spyOn(midtones, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 100
  } as DOMRect)
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
