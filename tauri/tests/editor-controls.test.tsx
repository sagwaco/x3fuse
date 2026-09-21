// @vitest-environment jsdom
import { useState, type Dispatch, type SetStateAction } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  DEFAULT_FILM,
  MONOCHROME_FILTERS,
  defaultRecipe,
  pasteRecipe,
  type EditRecipe
} from '@shared/editor'
import { EditorControls } from '../src/renderer/src/components/EditorControls'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { t } from '../src/renderer/src/lib/strings'

const originalChange = editor.getState().change
const originalCommit = editor.getState().commit
const change = vi.fn()
const commit = vi.fn()
const invoke = vi.fn()
let setRecipe: Dispatch<SetStateAction<EditRecipe>>
function Controls({ initial = defaultRecipe() }: { initial?: EditRecipe }): React.JSX.Element {
  const [recipe, update] = useState(initial)
  setRecipe = update
  return <EditorControls recipe={recipe} picking={false} setPicking={() => {}} />
}
function showAllSections(): void {
  document.querySelectorAll('details').forEach((details) => {
    details.open = true
  })
}
function reset(label: string): void {
  fireEvent.doubleClick(screen.getByRole('slider', { name: label }))
}
function adjust(label: string, value: number): void {
  fireEvent.change(screen.getByRole('spinbutton', { name: label }), {
    target: { value: String(value) }
  })
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
  change
    .mockReset()
    .mockImplementation((patch: Partial<EditRecipe>) =>
      setRecipe((recipe) => ({ ...recipe, ...patch }))
    )
  commit.mockReset()
  invoke.mockReset().mockResolvedValue(null)
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
      sourceHeight: 4000
    },
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

it('starts new photos with independent film settings and retains explicit film-disabled recipes', () => {
  const first = defaultRecipe()
  first.film!.evFilm = 2
  expect(defaultRecipe().film).toEqual(DEFAULT_FILM)
  expect(DEFAULT_FILM.evFilm).toBe(0)
  render(<Controls initial={{ ...defaultRecipe(), film: null, exposure: 1 }} />)
  expect(
    screen.getByRole('switch', { name: t('editor.filmEnabled') }).getAttribute('aria-checked')
  ).toBe('false')
  expect(
    screen.getByRole('slider', { name: t('editor.exposure') }).getAttribute('aria-valuenow')
  ).toBe('1')
  expect(screen.queryByRole('slider', { name: t('editor.evFilm') })).toBeNull()
})

it('places the film toggle above Light, explains it in a Radix tooltip, and switches the exposure binding', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const view = render(<Controls />)
  expect(
    view.container.firstElementChild?.querySelector('[role="switch"]')?.getAttribute('aria-label')
  ).toBe(t('editor.filmEnabled'))
  fireEvent.pointerMove(screen.getByRole('button', { name: t('editor.filmEnabled') }), {
    pointerType: 'mouse'
  })
  expect((await screen.findByRole('tooltip')).textContent).toBe(t('editor.filmHelp'))
  expect(screen.queryByRole('slider', { name: t('editor.exposure') })).toBeNull()
  adjust(t('editor.evFilm'), 1.5)
  expect(change).toHaveBeenLastCalledWith({ film: { ...DEFAULT_FILM, evFilm: 1.5 } }, true)
  reset(t('editor.evFilm'))
  expect(change).toHaveBeenLastCalledWith({ film: DEFAULT_FILM })
  fireEvent.click(screen.getByRole('switch', { name: t('editor.filmEnabled') }))
  adjust(t('editor.exposure'), -1)
  expect(change).toHaveBeenLastCalledWith({ exposure: -1 }, true)
  reset(t('editor.exposure'))
  expect(change).toHaveBeenLastCalledWith({ exposure: 0 })
})

it('enables monochrome independently of film and applies every filter through the existing dropdown', async () => {
  render(<Controls />)
  const toggle = screen.getByRole('switch', { name: t('editor.monochrome') })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByRole('button', { name: t('editor.filter') })).toBeNull()
  fireEvent.click(toggle)
  expect(change).toHaveBeenLastCalledWith({ monochrome: { filter: 'neutral' } })
  const dropdown = screen.getByRole('button', { name: t('editor.filter') })
  for (const filter of MONOCHROME_FILTERS) {
    invoke.mockResolvedValueOnce(filter)
    await act(async () => fireEvent.click(dropdown))
    expect(change).toHaveBeenLastCalledWith({ monochrome: { filter } })
    expect(dropdown.textContent).toBe(t(`editor.${filter}`))
  }
  expect(invoke).toHaveBeenCalledWith(
    'menu:popup',
    expect.objectContaining({
      items: expect.arrayContaining(
        MONOCHROME_FILTERS.map((filter) =>
          expect.objectContaining({ value: filter, label: t(`editor.${filter}`) })
        )
      )
    })
  )
  fireEvent.click(screen.getByRole('switch', { name: t('editor.filmEnabled') }))
  expect(dropdown.textContent).toBe(t('editor.blue'))
  act(() => editor.setState({ closing: true }))
  change.mockClear()
  fireEvent.click(toggle)
  expect(change).not.toHaveBeenCalled()
  act(() => editor.setState({ closing: false }))
  fireEvent.click(toggle)
  expect(change).toHaveBeenLastCalledWith({ monochrome: null })
  expect(defaultRecipe().monochrome).toBeNull()
  const source: EditRecipe = { ...defaultRecipe(), monochrome: { filter: 'red' } }
  const target = { ...defaultRecipe(), crop: { x: 0, y: 0.1, width: 1, height: 0.8 }, seed: 9 }
  expect(pasteRecipe(source, target)).toMatchObject({
    monochrome: { filter: 'red' },
    crop: target.crop,
    seed: 9
  })
})

it('resets slider thumbs to actual nonzero and nullable defaults and prevents resets while closing', () => {
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
  showAllSections()
  reset(t('editor.denoise'))
  expect(change).toHaveBeenLastCalledWith({ denoise: 10 })
  reset(t('editor.temperature'))
  expect(change).toHaveBeenLastCalledWith({ temperature: null })
  reset(t('editor.tint'))
  expect(change).toHaveBeenLastCalledWith({ tint: 0 })
  reset(t('editor.gammaFilm'))
  expect(change.mock.lastCall?.[0].film.gammaFilm).toBe(1)
  reset(t('editor.couplers'))
  expect(change.mock.lastCall?.[0].film.couplers).toBe(0.25)
  reset(t('editor.evPaper'))
  expect(change.mock.lastCall?.[0].film.evPaper).toBeNull()
  expect(screen.queryByRole('slider', { name: t('editor.evPaper') })).toBeNull()
  act(() => editor.setState({ closing: true }))
  change.mockClear()
  reset(t('editor.temperature'))
  expect(change).not.toHaveBeenCalled()
})

it('keeps individual grain and halation controls in closed Advanced sections and lets proxies update every parameter', () => {
  render(<Controls />)
  const spectral = screen.getByText(t('editor.film'), { selector: 'summary' })
    .parentElement as HTMLDetailsElement
  spectral.open = true
  const grainAdvanced = screen.getByText(t('editor.grainAdvanced'), { selector: 'summary' })
    .parentElement as HTMLDetailsElement
  const halationAdvanced = screen.getByText(t('editor.halationAdvanced'), { selector: 'summary' })
    .parentElement as HTMLDetailsElement
  expect(grainAdvanced.open).toBe(false)
  expect(halationAdvanced.open).toBe(false)
  expect(grainAdvanced.querySelector('[aria-label="Grain size"]')).toBeTruthy()
  adjust(t('editor.grain'), 100)
  expect(change.mock.lastCall?.[0].film).toMatchObject({
    grain: true,
    grainAmount: 2,
    grainSize: 4,
    grainSaturation: 1
  })
  adjust(t('editor.grain'), 0)
  expect(change.mock.lastCall?.[0].film).toMatchObject({
    grain: false,
    grainAmount: 0,
    grainSize: 0.25,
    grainSaturation: 0.5
  })
  reset(t('editor.grain'))
  expect(change.mock.lastCall?.[0].film).toMatchObject({
    grain: true,
    grainAmount: 1,
    grainSize: 1,
    grainSaturation: 1
  })
  adjust(t('editor.halation'), 100)
  expect(change.mock.lastCall?.[0].film).toMatchObject({
    halation: true,
    halationStrength: 2,
    halationRadius: 0.006,
    halationMidtones: 1
  })
  adjust(t('editor.halation'), 0)
  expect(change.mock.lastCall?.[0].film.halation).toBe(false)
  reset(t('editor.halation'))
  expect(change.mock.lastCall?.[0].film).toEqual(DEFAULT_FILM)
})

it('uses camera framing for As shot and reset, and exposes the requested aspect presets', async () => {
  const asShot = { x: 0.025, y: 0, width: 0.95, height: 1 }
  editor.setState({ session: { ...editor.getState().session!, asShotCrop: asShot } })
  render(<Controls initial={{ ...defaultRecipe(), crop: asShot }} />)
  showAllSections()
  const aspect = screen.getByRole('button', { name: t('editor.aspectRatio') })
  expect(aspect.textContent).toBe(t('editor.asShot'))
  invoke.mockResolvedValueOnce('65:24')
  await act(async () => fireEvent.click(aspect))
  expect(invoke).toHaveBeenCalledWith(
    'menu:popup',
    expect.objectContaining({
      items: expect.arrayContaining([
        expect.objectContaining({ value: 'asShot', label: t('editor.asShot'), checked: true }),
        expect.objectContaining({ value: '5:7' }),
        expect.objectContaining({ value: '6:7' }),
        expect.objectContaining({ value: '21:9' }),
        expect.objectContaining({ value: '65:24', label: '65:24 (XPan)' })
      ])
    })
  )
  const crop = change.mock.lastCall?.[0].crop
  expect((crop.width * 6000) / (crop.height * 4000)).toBeCloseTo(65 / 24)
  expect(aspect.textContent).toBe('65:24 (XPan)')
  invoke.mockResolvedValueOnce('asShot')
  await act(async () => fireEvent.click(aspect))
  expect(change).toHaveBeenLastCalledWith({ crop: asShot })
  fireEvent.click(screen.getByRole('button', { name: t('editor.resetCrop') }))
  expect(change).toHaveBeenLastCalledWith({ crop: asShot, rotation: 0, straighten: 0 })
})

it('infers saved crop ratios and applies portrait presets after a quarter turn without changing saved full-frame crops', async () => {
  editor.setState({
    session: { ...editor.getState().session!, asShotCrop: { x: 0, y: 0.05, width: 1, height: 0.9 } }
  })
  render(<Controls initial={{ ...defaultRecipe(), crop: null, rotation: 1 }} />)
  showAllSections()
  const aspect = screen.getByRole('button', { name: t('editor.aspectRatio') })
  expect(aspect.textContent).toBe(t('editor.free'))
  expect(change).not.toHaveBeenCalled()
  invoke.mockResolvedValueOnce('5:7')
  await act(async () => fireEvent.click(aspect))
  const crop = change.mock.lastCall?.[0].crop
  expect((crop.height * 4000) / (crop.width * 6000)).toBeCloseTo(5 / 7)
  expect(aspect.textContent).toBe('5:7')
})
