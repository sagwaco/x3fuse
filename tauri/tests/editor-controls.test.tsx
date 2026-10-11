// @vitest-environment jsdom
import { useState, type Dispatch, type SetStateAction } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  DEFAULT_FILM,
  FILM_MONOCHROME_FILTERS,
  MONOCHROME_FILTERS,
  defaultRecipe,
  pasteRecipe,
  type EditRecipe
} from '@shared/editor'
import { EditorControls } from '../src/renderer/src/components/EditorControls'
import { CropControls } from '../src/renderer/src/components/CropControls'
import { CropPreview } from '../src/renderer/src/components/CropPreview'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { t } from '../src/renderer/src/lib/strings'

const originalChange = editor.getState().change
const originalCommit = editor.getState().commit
const originalThumbnail = editor.getState().renderThumbnail
const change = vi.fn()
const commit = vi.fn()
const invoke = vi.fn()
const renderThumbnail = vi.fn()
let setRecipe: Dispatch<SetStateAction<EditRecipe>>
function Controls({ initial = defaultRecipe() }: { initial?: EditRecipe }): React.JSX.Element {
  const [recipe, update] = useState(initial)
  setRecipe = update
  return <EditorControls recipe={recipe} picking={false} setPicking={() => {}} />
}
function Crop({ initial = defaultRecipe() }: { initial?: EditRecipe }): React.JSX.Element {
  const [recipe, update] = useState(initial)
  const [aspect, setAspect] = useState('free')
  setRecipe = update
  return <CropControls recipe={recipe} aspect={aspect} setAspect={setAspect} />
}
function open(summary: string): HTMLDetailsElement {
  const details = screen.getByText(summary, { selector: 'summary, summary *' }).closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  return details
}
function reset(label: string): void {
  fireEvent.doubleClick(screen.getByRole('slider', { name: label }))
}
function adjust(label: string, value: number): void {
  fireEvent.change(screen.getByRole('spinbutton', { name: label }), {
    target: { value: String(value) }
  })
}
const film = (): EditRecipe['film'] => change.mock.lastCall?.[0].film
const swatch = (group: string, name: string): HTMLElement =>
  within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name })

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  change
    .mockReset()
    .mockImplementation((patch: Partial<EditRecipe>) =>
      setRecipe((recipe) => ({ ...recipe, ...patch }))
    )
  commit.mockReset()
  invoke.mockReset().mockResolvedValue(null)
  renderThumbnail
    .mockReset()
    .mockImplementation(async (recipe: EditRecipe) => `thumb:${recipe.film?.film ?? 'standard'}`)
  ;(window as unknown as { x3f: unknown }).x3f = { invoke, on: () => () => {} }
  queue.setState({ isProcessing: false, isPreparing: false })
  editor.setState({
    session: { sessionId: 'controls', path: '/a.X3F', recipe: defaultRecipe(), revision: 0 },
    preview: {
      sessionId: 'controls',
      revision: 0,
      url: 'preview',
      width: 1200,
      height: 800,
      sourceWidth: 6000,
      sourceHeight: 4000,
      asShotTemperature: 5150,
      asShotTint: 7
    },
    loading: false,
    closing: false,
    rendering: false,
    cropping: false,
    before: false,
    change,
    commit,
    renderThumbnail
  })
})
afterEach(() => {
  cleanup()
  editor.setState({
    change: originalChange,
    commit: originalCommit,
    renderThumbnail: originalThumbnail,
    session: null,
    preview: null
  })
  vi.unstubAllGlobals()
})

it('binds Exposure to the film when a stock is chosen and to the digital pipeline for Standard', () => {
  expect(defaultRecipe().film).toEqual(DEFAULT_FILM)
  render(<Controls initial={{ ...defaultRecipe(), film: null, exposure: 1 }} />)
  expect(screen.getByText(t('editor.standard'), { selector: 'summary *' })).toBeTruthy()
  expect(
    screen.getByRole('slider', { name: t('editor.exposure') }).getAttribute('aria-valuenow')
  ).toBe('1')
  cleanup()
  render(<Controls />)
  adjust(t('editor.exposure'), 1.5)
  expect(change).toHaveBeenLastCalledWith({ film: { ...DEFAULT_FILM, evFilm: 1.5 } }, true)
  reset(t('editor.exposure'))
  expect(change).toHaveBeenLastCalledWith({ film: DEFAULT_FILM })
})

it('previews every film stock on the photo and pairs each with its print paper', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  render(<Controls />)
  fireEvent.pointerMove(screen.getByRole('button', { name: t('editor.filmStock') }), {
    pointerType: 'mouse'
  })
  expect((await screen.findByRole('tooltip')).textContent).toBe(t('editor.filmHelp'))
  expect(renderThumbnail).not.toHaveBeenCalled()
  open('Kodak Portra 400')
  await waitFor(() => expect(renderThumbnail).toHaveBeenCalledTimes(24))
  expect(renderThumbnail.mock.calls[0][0].film).toBeNull()
  expect(renderThumbnail.mock.calls[1][0].monochrome).toEqual({ filter: 'neutral' })
  const gallery = screen.getByRole('group', { name: t('editor.filmStock') })
  await waitFor(() => expect(gallery.querySelectorAll('img')).toHaveLength(24))
  expect(screen.getByText(t('editor.slideFilm'))).toBeTruthy()
  expect(screen.getByText(t('editor.bwFilm'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Kodak Vision3 250D' }))
  expect(film()).toMatchObject({ film: 9, paper: 5, negative: false })
  // Slides are scanned directly, so they show the film itself.
  fireEvent.click(screen.getByRole('button', { name: 'Fujifilm Velvia 100' }))
  expect(film()).toMatchObject({ film: 18, paper: 5, negative: true })
  expect(screen.getByRole('button', { name: 'Fujifilm Velvia 100' }).ariaPressed).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: t('editor.standard') }))
  expect(change).toHaveBeenLastCalledWith({ film: null, monochrome: null })
  expect(screen.queryByRole('slider', { name: t('editor.grain') })).toBeNull()
})

it('offers black-and-white looks with their own filters, papers and darkroom', () => {
  render(<Controls />)
  const filters = (): Array<string | null> =>
    within(screen.getByRole('radiogroup', { name: t('editor.filter') }))
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('aria-label'))
  const papers = (): Array<string | null> =>
    within(screen.getByRole('group', { name: t('editor.paperStock') }))
      .getAllByRole('button')
      .map((button) => button.textContent)
  expect(screen.queryByRole('radiogroup', { name: t('editor.filter') })).toBeNull()
  expect(papers()).not.toContain('Kodak 2302')
  fireEvent.click(screen.getByRole('button', { name: 'Kodak Double-X 5222' }))
  expect(change).toHaveBeenLastCalledWith({
    film: { ...DEFAULT_FILM, film: 20, paper: 8, negative: false },
    monochrome: { filter: 'neutral' }
  })
  expect(filters()).toEqual(FILM_MONOCHROME_FILTERS.map((filter) => t(`editor.${filter}`)))
  expect(filters()).not.toContain(t('editor.blue'))
  expect(papers()).toEqual(['Kodak 2302'])
  expect(screen.queryByRole('slider', { name: t('editor.tuneY') })).toBeNull()
  expect(screen.queryByRole('slider', { name: t('editor.tuneM') })).toBeNull()
  expect(screen.queryByRole('slider', { name: t('editor.couplers') })).toBeNull()
  fireEvent.click(swatch(t('editor.filter'), t('editor.red')))
  expect(change).toHaveBeenLastCalledWith({ monochrome: { filter: 'red' } })
  expect(swatch(t('editor.filter'), t('editor.red')).ariaChecked).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Kodak Tri-X 7266' }))
  expect(change).toHaveBeenLastCalledWith({
    film: { ...DEFAULT_FILM, film: 21, paper: 8, negative: true },
    monochrome: { filter: 'red' }
  })
  // Reversal film is scanned directly: print controls and the switch are gone.
  expect(screen.queryByRole('group', { name: t('editor.paperStock') })).toBeNull()
  expect(screen.queryByRole('slider', { name: t('editor.evPaper') })).toBeNull()
  expect(screen.queryByRole('slider', { name: t('editor.gammaPaper') })).toBeNull()
  expect(screen.queryByRole('switch', { name: t('editor.negative') })).toBeNull()
  expect(screen.getByRole('slider', { name: t('editor.gammaFilm') })).toBeTruthy()
  // The look without film mixes the sensor layers, so it also offers blue.
  fireEvent.click(screen.getByRole('button', { name: t('editor.monochrome') }))
  expect(change).toHaveBeenLastCalledWith({ film: null, monochrome: { filter: 'red' } })
  expect(screen.getByRole('button', { name: t('editor.monochrome') }).ariaPressed).toBe('true')
  expect(filters()).toEqual(MONOCHROME_FILTERS.map((filter) => t(`editor.${filter}`)))
  fireEvent.click(swatch(t('editor.filter'), t('editor.blue')))
  fireEvent.click(screen.getByRole('button', { name: 'Kodak Double-X 5222' }))
  expect(change.mock.lastCall?.[0].monochrome).toEqual({ filter: 'neutral' })
  fireEvent.click(screen.getByRole('button', { name: 'Kodak Portra 400' }))
  expect(change).toHaveBeenLastCalledWith({ film: DEFAULT_FILM, monochrome: null })
  expect(screen.queryByRole('radiogroup', { name: t('editor.filter') })).toBeNull()
  expect(screen.getByRole('slider', { name: t('editor.tuneY') })).toBeTruthy()
  expect(defaultRecipe().monochrome).toBeNull()
  const source: EditRecipe = { ...defaultRecipe(), monochrome: { filter: 'red' } }
  const target = { ...defaultRecipe(), crop: { x: 0, y: 0.1, width: 1, height: 0.8 }, seed: 9 }
  expect(pasteRecipe(source, target)).toMatchObject({
    monochrome: { filter: 'red' },
    crop: target.crop,
    seed: 9
  })
})

it('starts white balance from the camera reading so leaving As shot does not jump', () => {
  render(<Controls />)
  expect(
    screen.getByRole('slider', { name: t('editor.temperature') }).getAttribute('aria-valuenow')
  ).toBe('5150')
  expect(screen.getByRole('button', { name: t('editor.asShot') }).ariaPressed).toBe('true')
  adjust(t('editor.temperature'), 5600)
  expect(change).toHaveBeenLastCalledWith({ temperature: 5600, tint: 7 }, true)
  adjust(t('editor.temperature'), 6000)
  expect(change).toHaveBeenLastCalledWith({ temperature: 6000 }, true)
  fireEvent.click(screen.getByRole('button', { name: t('editor.asShot') }))
  expect(change).toHaveBeenLastCalledWith({ temperature: null, tint: 0 })
})

it('resets sliders to actual nonzero and nullable defaults and prevents resets while closing', () => {
  render(
    <Controls
      initial={{
        ...defaultRecipe(),
        denoise: 3,
        temperature: 4000,
        tint: 30,
        film: { ...DEFAULT_FILM, evPaper: 2, gammaFilm: 1.5, couplers: 0.8 }
      }}
    />
  )
  document.querySelectorAll('details').forEach((details) => (details.open = true))
  reset(t('editor.denoise'))
  expect(change).toHaveBeenLastCalledWith({ denoise: 10 })
  reset(t('editor.temperature'))
  expect(change).toHaveBeenLastCalledWith({ temperature: null })
  reset(t('editor.tint'))
  expect(change).toHaveBeenLastCalledWith({ tint: 0 })
  reset(t('editor.gammaFilm'))
  expect(film()?.gammaFilm).toBe(1)
  reset(t('editor.couplers'))
  expect(film()?.couplers).toBe(0.25)
  reset(t('editor.evPaper'))
  expect(film()?.evPaper).toBeNull()
  act(() => editor.setState({ closing: true }))
  change.mockClear()
  reset(t('editor.temperature'))
  expect(change).not.toHaveBeenCalled()
})

it('maps grain, halation and darkroom sliders so dragging right does what the label says', () => {
  render(<Controls />)
  const darkroom = screen.getByText(t('editor.darkroom'), { selector: 'summary' })
    .parentElement as HTMLDetailsElement
  expect(darkroom.open).toBe(false)
  adjust(t('editor.grain'), 100)
  expect(film()).toMatchObject({ grain: true, grainAmount: 2 })
  adjust(t('editor.grainSize'), 100)
  expect(film()?.grainSize).toBeCloseTo(4)
  adjust(t('editor.grainSize'), 50)
  expect(film()?.grainSize).toBeCloseTo(1)
  adjust(t('editor.grain'), 0)
  expect(film()).toMatchObject({ grain: false, grainAmount: 0 })
  expect(screen.queryByRole('slider', { name: t('editor.grainSize') })).toBeNull()
  adjust(t('editor.halation'), 100)
  expect(film()).toMatchObject({
    halation: true,
    halationStrength: 2,
    halationRadius: 0.006,
    halationMidtones: 1
  })
  reset(t('editor.halation'))
  reset(t('editor.grain'))
  expect(film()).toMatchObject({ grain: true, grainAmount: 1, halation: false })
  // The enlarger darkens the print with more exposure and cools it with more
  // yellow filtration; the sliders invert both.
  adjust(t('editor.evPaper'), 1)
  expect(film()?.evPaper).toBe(-1)
  adjust(t('editor.tuneY'), 50)
  expect(film()?.tuneY).toBe(-0.5)
  adjust(t('editor.tuneM'), -100)
  expect(film()?.tuneM).toBe(1)
  adjust(t('editor.gammaPaper'), 100)
  expect(film()?.gammaPaper).toBe(2)
  adjust(t('editor.gammaFilm'), -100)
  expect(film()?.gammaFilm).toBe(0.5)
  adjust(t('editor.couplers'), 60)
  expect(film()?.couplers).toBe(0.6)
})

it('adjusts color ranges chosen from swatches and edits curve points from the keyboard', () => {
  render(<Controls />)
  fireEvent.click(swatch(t('editor.colorBand'), t('editor.blue')))
  adjust(t('editor.hue'), 40)
  expect(change.mock.lastCall?.[0].hsl[5]).toEqual({ hue: 40, saturation: 0, luminance: 0 })
  fireEvent.click(swatch(t('editor.curveChannel'), t('editor.red')))
  fireEvent.click(screen.getByRole('button', { name: t('editor.addPoint') }))
  const point = screen.getByRole('slider', { name: `${t('editor.curvePoint')} 2` })
  fireEvent.keyDown(point, { key: 'ArrowUp' })
  expect(change.mock.lastCall?.[0].curves.red[1].y).toBeCloseTo(0.51)
  fireEvent.keyDown(point, { key: 'Delete' })
  expect(change.mock.lastCall?.[0].curves.red).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: t('editor.addPoint') }))
  fireEvent.click(screen.getByRole('button', { name: t('editor.resetCurve') }))
  expect(change.mock.lastCall?.[0].curves.red).toEqual(defaultRecipe().curves.red)
})

it('uses camera framing for As shot and reset, and offers the aspect presets as shapes', () => {
  const asShot = { x: 0.025, y: 0, width: 0.95, height: 1 }
  editor.setState({ session: { ...editor.getState().session!, asShotCrop: asShot } })
  render(<Crop initial={{ ...defaultRecipe(), crop: asShot }} />)
  const xpan = screen.getByRole('radio', { name: 'XPan' })
  fireEvent.click(xpan)
  expect(xpan.ariaChecked).toBe('true')
  const crop = change.mock.lastCall?.[0].crop
  expect((crop.width * 6000) / (crop.height * 4000)).toBeCloseTo(65 / 24)
  for (const label of ['1:1', '4:3', '3:2', '7:5', '7:6', '16:9', '21:9'])
    expect(screen.getByRole('radio', { name: label })).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: t('editor.asShot') }))
  expect(change).toHaveBeenLastCalledWith({ crop: asShot })
  fireEvent.click(screen.getByRole('button', { name: t('editor.rotate') }))
  expect(change).toHaveBeenLastCalledWith({ rotation: 1 })
  fireEvent.click(screen.getByRole('button', { name: t('editor.rotateLeft') }))
  expect(change).toHaveBeenLastCalledWith({ rotation: 0 })
  adjust(t('editor.straighten'), -2.5)
  expect(change).toHaveBeenLastCalledWith({ straighten: -2.5 }, true)
  fireEvent.click(screen.getByRole('button', { name: t('editor.resetCrop') }))
  expect(change).toHaveBeenLastCalledWith({ crop: asShot, rotation: 0, straighten: 0 })
})

it('labels and applies portrait presets after a quarter turn and swaps orientation', () => {
  render(<Crop initial={{ ...defaultRecipe(), crop: null, rotation: 1 }} />)
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: '5:7' }))
  const crop = change.mock.lastCall?.[0].crop
  expect((crop.height * 4000) / (crop.width * 6000)).toBeCloseTo(5 / 7)
  fireEvent.click(screen.getByRole('button', { name: t('editor.swapOrientation') }))
  const swapped = change.mock.lastCall?.[0].crop
  expect((swapped.height * 4000) / (swapped.width * 6000)).toBeCloseTo(7 / 5)
  expect(screen.getByRole('radio', { name: '7:5' })).toBeTruthy()
})

it('nudges the crop in screen directions from the keyboard and applies on Return', () => {
  const done = vi.fn()
  const preview = editor.getState().preview!
  const recipe = { ...defaultRecipe(), crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }
  const view = render(<CropPreview preview={preview} recipe={recipe} locked onDone={done} />)
  const canvas = screen.getByRole('application', { name: t('editor.cropCanvas') })
  fireEvent.keyDown(canvas, { key: 'ArrowRight' })
  expect(change.mock.lastCall?.[0].crop.x).toBeCloseTo(0.25 + 8 / 1200)
  fireEvent.keyDown(canvas, { key: '-' })
  expect(change.mock.lastCall?.[0].crop.width).toBeCloseTo(0.475)
  // After a quarter turn clockwise, screen-right is up in the unrotated image.
  view.rerender(
    <CropPreview preview={preview} recipe={{ ...recipe, rotation: 1 }} locked onDone={done} />
  )
  fireEvent.keyDown(canvas, { key: 'ArrowRight' })
  expect(change.mock.lastCall?.[0].crop).toMatchObject({ x: 0.25 })
  expect(change.mock.lastCall?.[0].crop.y).toBeCloseTo(0.24)
  fireEvent.keyDown(canvas, { key: 'Enter' })
  expect(done).toHaveBeenCalledOnce()
})
