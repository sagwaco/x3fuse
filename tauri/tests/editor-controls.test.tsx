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
import { EditorControls, FilmControls } from '../src/renderer/src/components/EditorControls'
import { LookPicker } from '../src/renderer/src/components/LookPicker'
import { CropControls } from '../src/renderer/src/components/CropControls'
import { CropPreview } from '../src/renderer/src/components/CropPreview'
import { DevelopingCloud } from '../src/renderer/src/lib/developingCloud'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { t } from '../src/renderer/src/lib/strings'
import { cropToFrame, frameToCrop } from '../src/renderer/src/lib/cropGeometry'
import { pictureQuad } from '../src/renderer/src/lib/perspective'

const scope = vi.hoisted(() => ({
  image: 'loading' as unknown,
  url: undefined as string | undefined,
  level: vi.fn(),
  upright: vi.fn()
}))
vi.mock('../src/renderer/src/hooks/useScopeImage', () => ({
  useScopeImage: (url?: string) => ((scope.url = url), scope.image)
}))
vi.mock('../src/renderer/src/lib/upright', () => ({
  level: (...args: unknown[]) => scope.level(...args),
  upright: (...args: unknown[]) => scope.upright(...args)
}))

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
  const [page, setPage] = useState<'edit' | 'film' | 'paper' | 'darkroom'>('edit')
  return (
    <>
      {page !== 'edit' && <button onClick={() => setPage('edit')}>Back</button>}
      {page === 'edit' ? (
        <EditorControls
          recipe={recipe}
          picking={false}
          setPicking={() => {}}
          onNavigate={setPage}
        />
      ) : page === 'darkroom' ? (
        recipe.film && (
          <FilmControls recipe={recipe} film={recipe.film} darkroom onNavigate={setPage} />
        )
      ) : (
        <LookPicker kind={page} recipe={recipe} gallery />
      )}
    </>
  )
}
function Crop({ initial = defaultRecipe() }: { initial?: EditRecipe }): React.JSX.Element {
  const [recipe, update] = useState(initial)
  const [aspect, setAspect] = useState('free')
  setRecipe = update
  return <CropControls recipe={recipe} aspect={aspect} setAspect={setAspect} />
}
function back(): void {
  const button = screen.queryByRole('button', { name: 'Back' })
  if (button) fireEvent.click(button)
}
function darkroom(): void {
  back()
  fireEvent.click(screen.getByRole('button', { name: t('editor.darkroom') }))
}
/** Open a stock page from the full controls. */
function picker(caption: string): HTMLElement {
  back()
  if (caption === t('editor.paperStock')) darkroom()
  fireEvent.click(screen.getByText(caption, { selector: '[data-sidebar-page] *' }))
  return screen.getByRole('group', { name: caption })
}
function chooseFilm(name: string): void {
  picker(t('editor.filmStock'))
  fireEvent.click(screen.getByRole('button', { name }))
  back()
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
  HTMLImageElement.prototype.decode = () => Promise.resolve()
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
    previewPose: { pitch: 0, yaw: 0 },
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
  expect(screen.getByText(t('editor.standard'), { selector: '[data-sidebar-page] *' })).toBeTruthy()
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
  const gallery = picker(t('editor.filmStock'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('heading', { name: t('editor.cameraMatching') })).toBeTruthy()
  await waitFor(() => expect(renderThumbnail).toHaveBeenCalledTimes(24))
  expect(renderThumbnail.mock.calls[0][0].film).toBeNull()
  expect(renderThumbnail.mock.calls[1][0].monochrome).toEqual({ filter: 'neutral' })
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
  expect(change).toHaveBeenLastCalledWith({
    film: null,
    monochrome: null,
    cameraProfile: 'Standard'
  })
  expect(screen.queryByRole('slider', { name: t('editor.grain') })).toBeNull()
  back()
  expect(screen.getByText(t('editor.standard'), { selector: '[data-sidebar-page] *' })).toBeTruthy()
})

it('offers black-and-white looks with their own filters, papers and darkroom', () => {
  render(<Controls />)
  const filters = (): Array<string | null> =>
    within(screen.getByRole('radiogroup', { name: t('editor.filter') }))
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('aria-label'))
  const papers = (): Array<string | null> => {
    const names = within(picker(t('editor.paperStock')))
      .getAllByRole('button')
      .map((button) => button.textContent)
    back()
    return names
  }
  expect(papers()).not.toContain('Kodak 2302')
  chooseFilm('Kodak Double-X 5222')
  expect(change).toHaveBeenLastCalledWith({
    film: { ...DEFAULT_FILM, film: 20, paper: 8, negative: false },
    monochrome: { filter: 'neutral' },
    cameraProfile: null
  })
  expect(filters()).toEqual(FILM_MONOCHROME_FILTERS.map((filter) => t(`editor.${filter}`)))
  expect(papers()).toEqual(['Kodak 2302'])
  darkroom()
  for (const key of ['tuneY', 'tuneM', 'couplers'])
    expect(screen.queryByRole('slider', { name: t(`editor.${key}`) })).toBeNull()
  back()
  fireEvent.click(swatch(t('editor.filter'), t('editor.red')))
  expect(change).toHaveBeenLastCalledWith({ monochrome: { filter: 'red' } })
  chooseFilm('Kodak Tri-X 7266')
  expect(film()).toMatchObject({ film: 21, paper: 8, negative: true })
  darkroom()
  expect(screen.queryByText(t('editor.paperStock'))).toBeNull()
  expect(screen.queryByRole('slider', { name: t('editor.evPaper') })).toBeNull()
  expect(screen.queryByRole('slider', { name: t('editor.gammaPaper') })).toBeNull()
  expect(screen.queryByRole('switch', { name: t('editor.negative') })).toBeNull()
  expect(screen.getByRole('slider', { name: t('editor.gammaFilm') })).toBeTruthy()
  chooseFilm(t('editor.monochrome'))
  expect(change).toHaveBeenLastCalledWith({
    film: null,
    monochrome: { filter: 'red' },
    cameraProfile: 'Monochrome'
  })
  expect(filters()).toEqual(MONOCHROME_FILTERS.map((filter) => t(`editor.${filter}`)))
  fireEvent.click(swatch(t('editor.filter'), t('editor.blue')))
  chooseFilm('Kodak Double-X 5222')
  expect(change.mock.lastCall?.[0].monochrome).toEqual({ filter: 'neutral' })
  chooseFilm('Kodak Portra 400')
  expect(change).toHaveBeenLastCalledWith({
    film: DEFAULT_FILM,
    monochrome: null,
    cameraProfile: null
  })
  expect(screen.queryByRole('radiogroup', { name: t('editor.filter') })).toBeNull()
  darkroom()
  expect(screen.getByRole('slider', { name: t('editor.tuneY') })).toBeTruthy()
  const source: EditRecipe = { ...defaultRecipe(), monochrome: { filter: 'red' } }
  const target = { ...defaultRecipe(), crop: { x: 0, y: 0.1, width: 1, height: 0.8 }, seed: 9 }
  expect(pasteRecipe(source, target)).toMatchObject({
    monochrome: { filter: 'red' },
    crop: target.crop,
    seed: 9
  })
})

it('selects the logged camera profile and separates camera matching from film stocks', () => {
  editor.setState({
    session: {
      ...editor.getState().session!,
      asShotCameraProfile: 'FCBlue',
      cameraProfiles: [
        { id: 'Standard', name: 'Standard' },
        { id: 'Monochrome', name: 'Monochrome' },
        { id: 'FCBlue', name: 'FOV Blue' },
        { id: 'ForestGreen', name: 'Forest Green' }
      ]
    }
  })
  render(<Controls initial={{ ...defaultRecipe(), film: null, cameraProfile: 'FCBlue' }} />)
  expect(screen.getByText('FOV Blue')).toBeTruthy()
  picker(t('editor.filmStock'))
  expect(screen.getByRole('button', { name: 'FOV Blue' }).ariaPressed).toBe('true')
  expect(screen.getAllByRole('heading').map((node) => node.textContent)).toEqual([
    t('editor.cameraMatching'),
    t('editor.negativeFilm'),
    t('editor.slideFilm'),
    t('editor.cinemaFilm'),
    t('editor.bwFilm')
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Forest Green' }))
  expect(change).toHaveBeenLastCalledWith({
    cameraProfile: 'ForestGreen',
    film: null,
    monochrome: null
  })
  fireEvent.click(screen.getByRole('button', { name: 'Kodak Portra 400' }))
  expect(change.mock.lastCall?.[0].cameraProfile).toBeNull()
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

it('turns the controls on and shows the camera reading after the developing cloud leaves', () => {
  const view = render(
    <DevelopingCloud.Provider value>
      <Controls />
    </DevelopingCloud.Provider>
  )
  const temperature = (): HTMLElement =>
    screen.getByRole('slider', { name: t('editor.temperature') })
  const field = (): HTMLInputElement =>
    screen.getByRole('spinbutton', { name: t('editor.temperature') })
  expect(field().disabled).toBe(true)
  expect(temperature().getAttribute('aria-valuenow')).toBe('6500')
  view.rerender(
    <DevelopingCloud.Provider value={false}>
      <Controls />
    </DevelopingCloud.Provider>
  )
  expect(field().disabled).toBe(false)
  expect(temperature().getAttribute('aria-valuenow')).toBe('5150')
})

it('reads the crop-mode picture after the developing cloud leaves', () => {
  const view = render(
    <DevelopingCloud.Provider value>
      <Crop />
    </DevelopingCloud.Provider>
  )
  expect(scope.url).toBeUndefined()
  view.rerender(
    <DevelopingCloud.Provider value={false}>
      <Crop />
    </DevelopingCloud.Provider>
  )
  expect(scope.url).toBe(editor.getState().preview!.url)
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
  darkroom()
  reset(t('editor.gammaFilm'))
  expect(film()?.gammaFilm).toBe(1)
  reset(t('editor.couplers'))
  expect(film()?.couplers).toBe(0.25)
  reset(t('editor.evPaper'))
  expect(film()?.evPaper).toBeNull()
  back()
  act(() => editor.setState({ closing: true }))
  change.mockClear()
  reset(t('editor.temperature'))
  expect(change).not.toHaveBeenCalled()
})

it('maps grain, halation and darkroom sliders so dragging right does what the label says', () => {
  render(<Controls />)
  expect(screen.queryByRole('slider', { name: t('editor.evPaper') })).toBeNull()
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
  darkroom()
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
  adjust(t('editor.straighten'), -2.5)
  expect(change).toHaveBeenLastCalledWith({ straighten: -2.5 }, true)
  // Reset, at the section's top right, restores the camera's frame and its aspect.
  fireEvent.click(screen.getByRole('radio', { name: '1:1' }))
  fireEvent.click(screen.getByRole('button', { name: t('editor.resetCrop') }))
  expect(change).toHaveBeenLastCalledWith({
    crop: asShot,
    straighten: 0,
    rotation: 0,
    pitch: 0,
    yaw: 0
  })
  expect(screen.getByRole('radio', { name: t('editor.asShot') }).ariaChecked).toBe('true')
  // Rotate, cancel and apply live in the crop-mode toolbar (editor-screen tests).
})

it('levels and uprights the crop-mode picture and reports when nothing is found', () => {
  const picture = { data: new Uint8ClampedArray(16), width: 2, height: 2 }
  scope.image = 'loading'
  scope.level.mockReset()
  scope.upright.mockReset()
  render(<Crop />)
  const straighten = screen.getByRole('button', { name: t('editor.levelPicture') })
  const upright = screen.getByRole('button', { name: t('editor.upright') })
  expect(straighten).toHaveProperty('disabled', true)
  expect(upright).toHaveProperty('disabled', true)
  cleanup()

  scope.image = picture
  render(<Crop />)
  scope.level.mockReturnValueOnce(1.5).mockReturnValueOnce(null)
  fireEvent.click(screen.getByRole('button', { name: t('editor.levelPicture') }))
  expect(scope.level).toHaveBeenCalledWith(picture, { pitch: 0, yaw: 0 }, 6000, 4000)
  expect(change).toHaveBeenLastCalledWith({ straighten: 1.5 }, true)
  change.mockClear()
  fireEvent.click(screen.getByRole('button', { name: t('editor.levelPicture') }))
  expect(change).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toBe(t('editor.noLines'))

  scope.upright.mockReturnValueOnce({ straighten: -2, pitch: 6, yaw: -3 })
  fireEvent.click(screen.getByRole('button', { name: t('editor.upright') }))
  expect(scope.upright).toHaveBeenCalledWith(picture, { pitch: 0, yaw: 0 }, 6000, 4000)
  const [patch, save] = change.mock.lastCall!
  expect(patch).toMatchObject({ straighten: -2, pitch: 6, yaw: -3 })
  expect(save).toBe(true)
  // The new crop keeps the 3:2 frame, centered, and is smaller than the full image.
  expect(patch.crop.width / patch.crop.height).toBeCloseTo(1)
  expect(patch.crop.width).toBeLessThan(1)
  expect(patch.crop.x + patch.crop.width / 2).toBeCloseTo(0.5, 1)
  scope.image = 'loading'
})

it('keeps every crop write inside the picture outline after Upright adds pitch', () => {
  scope.image = { data: new Uint8ClampedArray(16), width: 2, height: 2 }
  const asShot = { x: 0, y: 0, width: 1, height: 1 }
  editor.setState({ session: { ...editor.getState().session!, asShotCrop: asShot } })
  render(<Crop />)
  scope.upright.mockReturnValueOnce({ straighten: 0, pitch: 12, yaw: 0 })
  fireEvent.click(screen.getByRole('button', { name: t('editor.upright') }))
  const valid = (crop: EditRecipe['crop']): boolean =>
    crop !== null &&
    frameToCrop(cropToFrame(crop, 0, 6000, 4000), 0, 6000, 4000, pictureQuad(12, 0, 6000, 4000)) !==
      null
  fireEvent.click(screen.getByRole('radio', { name: '3:2' }))
  const ratio = change.mock.lastCall![0].crop
  expect(ratio.width).toBeLessThan(1)
  expect(valid(ratio)).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: t('editor.asShot') }))
  const shot = change.mock.lastCall![0].crop
  expect(shot.width).toBeLessThan(1)
  expect(valid(shot)).toBe(true)
  scope.image = 'loading'
})

it('refits the crop when the straighten slider resets under perspective', () => {
  const full = { x: 0, y: 0, width: 1, height: 1 }
  const quad = pictureQuad(25, 0, 6000, 4000)
  // A strong straighten zooms the full frame far enough to fit the outline.
  expect(frameToCrop(cropToFrame(full, 40, 6000, 4000), 40, 6000, 4000, quad)).not.toBeNull()
  expect(frameToCrop(cropToFrame(full, 0, 6000, 4000), 0, 6000, 4000, quad)).toBeNull()
  render(<Crop initial={{ ...defaultRecipe(), crop: full, straighten: 40, pitch: 25 }} />)
  reset(t('editor.straighten'))
  const patch = change.mock.lastCall![0]
  expect(patch.straighten).toBe(0)
  expect(patch.crop.width).toBeLessThan(1)
  expect(frameToCrop(cropToFrame(patch.crop, 0, 6000, 4000), 0, 6000, 4000, quad)).not.toBeNull()
})

it('does not analyze a preview rendered with other angles, as after a failed render', () => {
  scope.image = { data: new Uint8ClampedArray(16), width: 2, height: 2 }
  scope.upright.mockReset().mockReturnValue({ straighten: 0, pitch: 6, yaw: 0 })
  render(<Crop />)
  const upright = screen.getByRole('button', { name: t('editor.upright') })
  fireEvent.click(upright)
  expect(scope.upright).toHaveBeenCalledOnce()
  // The render for pitch 6 fails: the store keeps the old pixels and their old pose.
  expect(editor.getState().previewPose).toEqual({ pitch: 0, yaw: 0 })
  expect(upright).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: t('editor.levelPicture') })).toHaveProperty(
    'disabled',
    true
  )
  fireEvent.click(upright)
  expect(scope.upright).toHaveBeenCalledOnce()
  // A render with the new angles makes them usable again.
  act(() => editor.setState({ previewPose: { pitch: 6, yaw: 0 } }))
  expect(upright).toHaveProperty('disabled', false)
  scope.image = 'loading'
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

it('decodes the crop preview image before it shows, and reports a paint when it loads', async () => {
  const onPaint = vi.fn()
  const preview = editor.getState().preview!
  const view = render(
    <CropPreview
      preview={preview}
      recipe={defaultRecipe()}
      locked
      onDone={() => {}}
      onPaint={onPaint}
    />
  )
  expect(view.container.querySelector('image')).toBeNull()
  await act(async () => {})
  expect(view.container.querySelector('image')!.getAttribute('href')).toBe(preview.url)
  expect(onPaint).not.toHaveBeenCalled()
  fireEvent.load(view.container.querySelector('image')!)
  expect(onPaint).toHaveBeenCalledOnce()
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

it('maps the perspective sliders to pitch and yaw, fitting the crop, and restores it when dragged back', () => {
  render(<Crop initial={{ ...defaultRecipe(), crop: null }} />)
  const fits = (patch: Partial<EditRecipe>): boolean =>
    frameToCrop(
      cropToFrame(patch.crop!, 0, 6000, 4000),
      0,
      6000,
      4000,
      pictureQuad(patch.pitch ?? 0, patch.yaw ?? 0, 6000, 4000)
    ) !== null
  adjust(t('editor.perspectiveVertical'), 20)
  const vertical = change.mock.lastCall![0]
  expect(vertical.pitch).toBe(20)
  expect(vertical.crop.width).toBeLessThan(1)
  expect(fits(vertical)).toBe(true)
  act(() => setRecipe({ ...defaultRecipe(), crop: null }))
  adjust(t('editor.perspectiveHorizontal'), -15)
  const horizontal = change.mock.lastCall![0]
  expect(horizontal.yaw).toBe(-15)
  expect(fits(horizontal)).toBe(true)

  // Drag the Vertical slider out and back: the frame returns to the full picture.
  act(() => setRecipe({ ...defaultRecipe(), crop: null }))
  vi.stubGlobal('PointerEvent', MouseEvent)
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const saved = ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'].map((k) => [
    k,
    proto[k]
  ])
  proto.setPointerCapture = () => {}
  proto.releasePointerCapture = () => {}
  proto.hasPointerCapture = () => true
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 10 }))
  try {
    const thumb = screen.getByRole('slider', { name: t('editor.perspectiveVertical') })
    const root = thumb.closest('[data-orientation]')!.parentElement!.closest('[data-orientation]')
    const track = root ?? thumb.closest('[data-orientation]')!
    fireEvent.pointerDown(track, { clientX: 75, pointerId: 1, button: 0 })
    expect(change.mock.lastCall![0].pitch).toBe(20)
    expect(change.mock.lastCall![0].crop.width).toBeLessThan(1)
    fireEvent.pointerMove(track, { clientX: 50, pointerId: 1 })
    expect(change.mock.lastCall![0]).toEqual({ pitch: 0, crop: null })
    // Back at its start value, Radix sends no commit at release.
    fireEvent.pointerUp(track, { clientX: 50, pointerId: 1 })
    // A crop chosen afterwards must not be replaced by that drag's start crop.
    fireEvent.click(screen.getByRole('radio', { name: '3:2' }))
    adjust(t('editor.straighten'), 1)
    expect(change).toHaveBeenLastCalledWith({ straighten: 1 }, true)
  } finally {
    rect.mockRestore()
    for (const [k, v] of saved) proto[k as string] = v
  }
})

it('shows Standard when a copied camera profile is unavailable in the photo', () => {
  render(<Controls initial={{ ...defaultRecipe(), film: null, cameraProfile: 'FCBlue' }} />)
  expect(screen.getByText(t('editor.standard'), { selector: '[data-sidebar-page] *' })).toBeTruthy()
  picker(t('editor.filmStock'))
  expect(screen.getByRole('button', { name: t('editor.standard'), exact: true }).ariaPressed).toBe(
    'true'
  )
  expect(screen.queryByRole('button', { name: 'FOV Blue' })).toBeNull()
})
