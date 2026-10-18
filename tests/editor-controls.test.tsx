// @vitest-environment jsdom
import { useState, type Dispatch, type SetStateAction } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  DEFAULT_FILM,
  FILM_MONOCHROME_FILTERS,
  MONOCHROME_FILTERS,
  defaultRecipe,
  filmGrainDefaults,
  pasteRecipe,
  type EditRecipe
} from '@shared/editor'
import { defaultDenoiseOptions } from '@shared/denoise'
import { EditorControls, EmulsionControls } from '../src/renderer/src/components/EditorControls'
import { DenoiseControls } from '../src/renderer/src/components/DenoiseControls'
import { LookPicker } from '../src/renderer/src/components/LookPicker'
import { CropControls } from '../src/renderer/src/components/CropControls'
import { CropPreview } from '../src/renderer/src/components/CropPreview'
import { DevelopingCloud } from '../src/renderer/src/lib/developingCloud'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { t } from '../src/renderer/src/lib/strings'
import { cropToFrame, frameToCrop } from '../src/renderer/src/lib/cropGeometry'
import { pictureQuad } from '../src/renderer/src/lib/perspective'
import { formatBytes } from '../src/renderer/src/lib/format'

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
const setPicking = vi.fn()
let setRecipe: Dispatch<SetStateAction<EditRecipe>>
function Controls({ initial = defaultRecipe() }: { initial?: EditRecipe }): React.JSX.Element {
  const [recipe, update] = useState(initial)
  setRecipe = update
  const [page, setPage] = useState<'edit' | 'emulsion' | 'paper'>('edit')
  return (
    <>
      {page !== 'edit' && <button onClick={() => setPage('edit')}>Back</button>}
      {page === 'edit' ? (
        <EditorControls
          recipe={recipe}
          picking={false}
          setPicking={setPicking}
          onNavigate={setPage}
        />
      ) : (
        <>
          <div hidden={page !== 'emulsion'}>
            <EmulsionControls recipe={recipe} />
          </div>
          {page === 'paper' && <LookPicker kind="paper" recipe={recipe} gallery />}
        </>
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
  let button = screen.queryByRole('button', { name: 'Back' })
  while (button) {
    fireEvent.click(button)
    button = screen.queryByRole('button', { name: 'Back' })
  }
}
/** Show a tab of the edit sidebar, leaving any stock page first. */
function panelTab(tab: 'raw' | 'film' | 'grading'): void {
  back()
  fireEvent.click(
    screen.getByRole('tab', { name: t(`editor.tab${tab[0].toUpperCase()}${tab.slice(1)}`) })
  )
}
function darkroom(): void {
  panelTab('film')
}
/** Open a stock page from the full controls. */
function picker(caption: string): HTMLElement {
  panelTab('film')
  fireEvent.click(
    screen.getByText(caption === t('editor.paperStock') ? caption : t('editor.look'), {
      selector: '[data-sidebar-page] *'
    })
  )
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
const swatch = (group: string, name: string): HTMLElement => {
  if (group === t('editor.filter')) picker(t('editor.filmStock'))
  return within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name })
}

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
  localStorage.clear()
  editor.setState({
    change: originalChange,
    commit: originalCommit,
    renderThumbnail: originalThumbnail,
    session: null,
    preview: null,
    x3i: null
  })
  vi.unstubAllGlobals()
})

const sections = (container: HTMLElement): Array<string | null> =>
  [...container.querySelectorAll('summary')].map((node) => node.textContent)

it('groups the sidebar into RAW, FILM and GRADING tabs that start on RAW', () => {
  const view = render(<Controls />)
  expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-selected'))).toEqual([
    'true',
    'false',
    'false'
  ])
  expect(sections(view.container)).toEqual([
    t('editor.light'),
    t('editor.curves'),
    t('editor.whiteBalance'),
    t('editor.detail'),
    t('denoise.advanced')
  ])
  panelTab('film')
  expect(sections(view.container)).toEqual([
    t('editor.look'),
    t('editor.effects'),
    t('editor.grainChannelOffsets')
  ])
  const button = screen.getByText(t('editor.look'), { selector: '[data-sidebar-page] *' })
  const paper = screen.getByText(t('editor.paperStock'), { selector: '[data-sidebar-page] *' })
  expect(button.compareDocumentPosition(paper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('slider', { name: t('editor.gammaFilm') })).toBeTruthy()
  panelTab('grading')
  expect(sections(view.container).slice(0, 1)).toEqual([t('editor.color')])
  expect(sections(view.container)).not.toContain(t('editor.effects'))
})

it('supports arrow keys between the panel tabs and shows only the film button without a stock', () => {
  const view = render(<Controls />)
  const tabs = screen.getAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual(
    ['tabRaw', 'tabFilm', 'tabGrading'].map((key) => t(`editor.${key}`))
  )
  fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
  expect(setPicking).toHaveBeenLastCalledWith(false)
  expect(tabs[1].getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(tabs[1])
  fireEvent.keyDown(tabs[1], { key: 'End' })
  expect(tabs[2].getAttribute('aria-selected')).toBe('true')
  setPicking.mockClear()
  fireEvent.keyDown(tabs[2], { key: 'ArrowRight' })
  expect(setPicking).not.toHaveBeenCalled()
  expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' })
  expect(tabs[2].getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(tabs[2], { key: 'Home' })
  expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  fireEvent.click(tabs[1])
  expect(setPicking).toHaveBeenCalledWith(false)
  act(() => setRecipe({ ...defaultRecipe(), film: null }))
  expect(sections(view.container)).toEqual([t('editor.look'), t('editor.effects')])
  expect(
    screen.queryByText(t('editor.paperStock'), { selector: '[data-sidebar-page] *' })
  ).toBeNull()
  expect(screen.queryByRole('slider', { name: t('editor.gammaFilm') })).toBeNull()
  expect(change).not.toHaveBeenCalled()
})

it('opens every section until it is closed, and keeps closed sections closed', async () => {
  const details = (label: string): HTMLDetailsElement =>
    screen.getByText(label, { selector: 'summary' }).closest('details')!
  const advanced = t('denoise.advanced')
  const raw = [
    ...['light', 'curves', 'whiteBalance', 'detail'].map((key) => t(`editor.${key}`)),
    advanced
  ]
  const open = (): boolean[] => raw.map((label) => details(label).open)
  render(<Controls />)
  expect(open()).toEqual([true, true, true, true, true])
  // Each write keeps the states that the other sections stored.
  for (const label of [t('editor.curves'), t('editor.detail'), advanced])
    fireEvent.click(screen.getByText(label, { selector: 'summary' }))
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem('x3fuse.sections')!)).toEqual({
      curves: false,
      detail: false,
      denoiseAdvanced: false
    })
  )
  cleanup()
  render(<Controls />)
  expect(open()).toEqual([true, false, true, false, false])
  panelTab('film')
  expect(details(t('editor.look')).open && details(t('editor.effects')).open).toBe(true)
  panelTab('raw')
  expect(open()).toEqual([true, false, true, false, false])
  // A fresh storage, or one that fails, opens every section.
  cleanup()
  localStorage.clear()
  render(<Controls />)
  expect(open()).toEqual([true, true, true, true, true])
  const failing = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied')
  })
  cleanup()
  render(<Controls />)
  expect(open()).toEqual([true, true, true, true, true])
  failing.mockRestore()
  // Without a storage id, as in the conversion form, Advanced starts closed and stores nothing.
  cleanup()
  render(<DenoiseControls value={defaultDenoiseOptions()} change={vi.fn()} />)
  expect(details(advanced).open).toBe(false)
  fireEvent.click(screen.getByText(advanced, { selector: 'summary' }))
  await waitFor(() => expect(details(advanced).open).toBe(true))
  expect(localStorage.getItem('x3fuse.sections')).toBeNull()
})

it('keeps section headers at the top of the sidebar while their sections scroll', () => {
  const summary = (label: string): string[] =>
    screen.getByText(label, { selector: 'summary' }).className.split(' ')
  render(<Controls />)
  // A section header sticks at the top. A nested one sticks below its parent header,
  // which is h-10 high, and goes under it.
  expect(summary(t('editor.light'))).toEqual(
    expect.arrayContaining(['sticky', 'top-0', 'z-20', 'h-10', '[details_details>&]:top-10'])
  )
  // The header is opaque, so the fields that scroll under it do not show through.
  expect(summary(t('editor.light')).join(' ')).toContain('bg-[color:color-mix(')
  expect(summary(t('denoise.advanced'))).toEqual(
    expect.arrayContaining(['sticky', 'top-10', 'z-10'])
  )
  // In the conversion form, Advanced does not stick.
  cleanup()
  render(<DenoiseControls value={defaultDenoiseOptions()} change={vi.fn()} />)
  expect(summary(t('denoise.advanced'))).not.toContain('sticky')
})

it('binds Exposure to the film when a stock is chosen and to the digital pipeline for Standard', () => {
  expect(defaultRecipe().film).toEqual(DEFAULT_FILM)
  render(<Controls initial={{ ...defaultRecipe(), film: null, exposure: 1 }} />)
  panelTab('film')
  expect(screen.getByText(t('editor.standard'), { selector: '[data-sidebar-page] *' })).toBeTruthy()
  panelTab('raw')
  expect(
    screen.getByRole('slider', { name: t('editor.exposure') }).getAttribute('aria-valuenow')
  ).toBe('1')
  cleanup()
  render(<Controls />)
  // The label shows the unit; the slider keeps its plain name.
  expect(screen.getByText(`${t('editor.exposure')} (EV)`)).toBeTruthy()
  adjust(t('editor.exposure'), 1.5)
  expect(change).toHaveBeenLastCalledWith({ film: { ...DEFAULT_FILM, evFilm: 1.5 } }, true)
  reset(t('editor.exposure'))
  expect(change).toHaveBeenLastCalledWith({ film: DEFAULT_FILM })
})

it('shows the chosen film stock as a labeled canister on the Emulsion button', () => {
  const canister = (kind: 'film' | 'paper', recipe: Partial<EditRecipe>): string[] | null => {
    const view = render(<LookPicker kind={kind} recipe={{ ...defaultRecipe(), ...recipe }} />)
    const label = view.container.querySelector('svg text')
    view.unmount()
    return label && [label.textContent!, label.getAttribute('fill')!]
  }
  const film = (index: number): Partial<EditRecipe> => ({ film: { ...DEFAULT_FILM, film: index } })
  expect(canister('film', film(14))).toEqual(['200', '#009a49'])
  expect(canister('film', film(11))).toEqual(['500T', '#f7b218'])
  expect(canister('film', { ...film(20), monochrome: { filter: 'neutral' } })).toEqual([
    '5222',
    '#f2f2ec'
  ])
  expect(
    canister('film', {
      film: { ...DEFAULT_FILM, film: 15, negative: true },
      cameraProfile: 'FCBlue'
    })
  ).toEqual(['IR', '#f7b218'])
  expect(canister('film', { film: null })).toBeNull()
  expect(canister('paper', film(14))).toBeNull()
})

it('previews every film stock on the photo and pairs each with its print paper', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  render(<Controls />)
  panelTab('film')
  fireEvent.pointerMove(screen.getByRole('button', { name: t('editor.look') }), {
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
  expect(screen.queryByRole('switch', { name: t('editor.grain') })).toBeNull()
  panelTab('film')
  expect(screen.getByText(t('editor.standard'), { selector: '[data-sidebar-page] *' })).toBeTruthy()
})

it('offers black-and-white looks with their own filters, papers and darkroom', () => {
  render(<Controls />)
  const filters = (): Array<string | null> => {
    picker(t('editor.filmStock'))
    return within(screen.getByRole('radiogroup', { name: t('editor.filter') }))
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('aria-label'))
  }
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
    film: {
      ...DEFAULT_FILM,
      film: 20,
      paper: 8,
      negative: false,
      grainParams: filmGrainDefaults(20)
    },
    monochrome: { filter: 'neutral' },
    cameraProfile: null
  })
  expect(filters()).toEqual(FILM_MONOCHROME_FILTERS.map((filter) => t(`editor.${filter}`)))
  expect(papers()).toEqual(['Kodak 2302', t('editor.negativePrint')])
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
  // A reversal film is already a positive, so there is nothing to invert.
  expect(screen.queryByRole('switch', { name: t('editor.negativePreview') })).toBeNull()
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

it('toggles the SFD RAW of an X3I above Light, and paste keeps the frames of each photo', () => {
  const processX3i = vi.fn()
  const cancelX3i = vi.fn()
  const deleteX3i = vi.fn()
  const original = editor.getState()
  editor.setState({ processX3i, cancelX3i, deleteX3i })
  // jsdom has no canvas, so the cube draws nothing.
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const view = render(<Controls />)
  const toggle = (): HTMLElement => screen.getByRole('switch', { name: t('editor.sfdUse') })
  const info = (): HTMLElement | null => screen.queryByRole('button', { name: t('editor.sfdInfo') })
  expect(screen.queryByText(t('editor.sfdRaw'), { selector: 'summary' })).toBeNull()
  // Without an SFD RAW: the facts are in a popover by the title.
  act(() => editor.setState({ x3i: { frames: 7, processed: false } }))
  const sections = [...view.container.querySelectorAll('summary')].map((node) => node.textContent)
  expect(sections.slice(0, 2)).toEqual([t('editor.sfdRaw'), t('editor.light')])
  expect(info()).not.toBeNull()
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(screen.getByText(t('editor.x3iSourceMiddle'))).toBeTruthy()
  fireEvent.click(toggle())
  expect(processX3i).toHaveBeenCalledTimes(1)
  // The fuse button beside the unfused RAW merges too.
  fireEvent.click(screen.getByRole('button', { name: t('editor.sfdFuse') }))
  expect(processX3i).toHaveBeenCalledTimes(2)
  // A merge turns the toggle on and holds it. Its button cancels it.
  act(() => editor.setState({ x3i: { frames: 7, processed: false, progress: 0.4 } }))
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  expect((toggle() as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40')
  expect(screen.getByText(t('editor.x3iMerging')).className).toContain('text-shimmer')
  expect(screen.queryByRole('button', { name: t('editor.sfdFuse') })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: t('button.cancel') }))
  expect(cancelX3i).toHaveBeenCalled()
  expect(change).not.toHaveBeenCalled()
  // With an SFD RAW: its file name and size, with a delete button.
  act(() =>
    editor.setState({ x3i: { frames: 7, processed: true, name: 'a-0123.sfd', bytes: 306_727_439 } })
  )
  expect(info()).toBeNull()
  expect(screen.getByText(t('editor.sfdFused')).getAttribute('title')).toBe('a-0123.sfd')
  expect(screen.getByText(formatBytes(306_727_439))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('editor.sfdDelete') }))
  expect(deleteX3i).toHaveBeenCalled()
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  // A change between the two RAWs holds the toggle until it finishes.
  act(() => editor.setState({ switching: true }))
  expect((toggle() as HTMLButtonElement).disabled).toBe(true)
  act(() => editor.setState({ switching: false }))
  expect((toggle() as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(toggle())
  expect(change).toHaveBeenLastCalledWith({ x3iSource: 'merge' })
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  // The unfused RAW is absent from a recipe.
  fireEvent.click(toggle())
  expect(change).toHaveBeenLastCalledWith({ x3iSource: undefined })
  // An SFD RAW that the photo uses but that is not stored merges, and the
  // other sections wait for it.
  const sfd: EditRecipe = { ...defaultRecipe(), x3iSource: 'merge' }
  processX3i.mockClear()
  act(() => {
    setRecipe(sfd)
    editor.setState({
      x3i: { frames: 7, processed: false },
      documents: { '/a.X3F': { recipe: sfd } as never }
    })
  })
  expect(processX3i).toHaveBeenCalledTimes(1)
  expect(
    screen.getByText(t('editor.light'), { selector: 'summary' }).closest('[inert]')
  ).not.toBeNull()
  expect(toggle().closest('[inert]')).toBeNull()
  editor.setState({
    processX3i: original.processX3i,
    cancelX3i: original.cancelX3i,
    deleteX3i: original.deleteX3i,
    documents: original.documents
  })
  expect(pasteRecipe(sfd, defaultRecipe()).x3iSource).toBeUndefined()
  expect(pasteRecipe(defaultRecipe(), sfd).x3iSource).toBe('merge')
  canvas.mockRestore()
})

it('sets Fill Light on the SIGMA Photo Pro scale, -2 to 2 in steps of 0.1', () => {
  render(<Controls />)
  const slider = screen.getByRole('slider', { name: t('editor.fillLight') })
  expect([slider.getAttribute('aria-valuemin'), slider.getAttribute('aria-valuemax')]).toEqual([
    '-2',
    '2'
  ])
  adjust(t('editor.fillLight'), 3)
  expect(change).toHaveBeenLastCalledWith({ fillLight: 2 }, true)
  adjust(t('editor.fillLight'), 0.54)
  expect(change.mock.lastCall?.[0].fillLight).toBeCloseTo(0.5)
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
  panelTab('film')
  expect(screen.getByText('FOV Blue')).toBeTruthy()
  picker(t('editor.filmStock'))
  expect(screen.getByRole('button', { name: 'FOV Blue' }).ariaPressed).toBe('true')
  expect(screen.getAllByRole('heading').map((node) => node.textContent)).toEqual([
    t('editor.cameraMatching'),
    t('editor.negativeFilm'),
    t('editor.slideFilm'),
    t('editor.cinemaFilm'),
    t('editor.bwFilm'),
    t('editor.fullSpectrum')
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

it('selects and restores Aerochrome with the existing camera and film recipe', () => {
  editor.setState({
    session: {
      ...editor.getState().session!,
      cameraProfiles: [{ id: 'FCBlue', name: 'FOV Classic Blue' }]
    }
  })
  const initial: EditRecipe = {
    ...defaultRecipe(),
    temperature: 2335,
    tint: 115,
    monochrome: { filter: 'green' },
    film: { ...DEFAULT_FILM, film: 20, paper: 8, evFilm: 0.5 }
  }
  render(<Controls initial={initial} />)
  chooseFilm(t('editor.aerochrome'))
  expect(change.mock.lastCall?.[0]).toMatchObject({
    cameraProfile: 'FCBlue',
    monochrome: null,
    film: {
      film: 15,
      paper: 0,
      negative: true,
      evFilm: 0.5,
      grainParams: filmGrainDefaults(15)
    }
  })
  const saved: EditRecipe = JSON.parse(JSON.stringify({ ...initial, ...change.mock.lastCall?.[0] }))
  expect(saved.temperature).toBe(1170)
  expect(saved.tint).toBe(-263)
  expect(
    screen.getByRole('switch', { name: t('editor.extendedRange') }).getAttribute('aria-checked')
  ).toBe('true')
  const pasted = pasteRecipe(saved, defaultRecipe())
  act(() => setRecipe(pasted))
  panelTab('film')
  expect(
    screen.getByText(t('editor.aerochrome'), { selector: '[data-sidebar-page] *' })
  ).toBeTruthy()
  picker(t('editor.filmStock'))
  expect(screen.getByRole('button', { name: t('editor.aerochrome') }).ariaPressed).toBe('true')
  expect(screen.getByText(t('editor.aerochromeHelp'))).toBeTruthy()
  // Selecting the active look keeps the user's white balance and grain edits.
  act(() =>
    setRecipe({
      ...pasted,
      temperature: 1500,
      tint: -210,
      film: { ...pasted.film!, grainParams: { ...pasted.film!.grainParams!, blur: 2 } }
    })
  )
  fireEvent.click(screen.getByRole('button', { name: t('editor.aerochrome') }))
  expect(change.mock.lastCall?.[0]).toMatchObject({
    temperature: 1500,
    tint: -210,
    film: { grainParams: { blur: 2 } }
  })
  darkroom()
  expect(screen.queryByText(t('editor.paperStock'))).toBeNull()
  chooseFilm('Kodak Ektachrome 100')
  expect(change.mock.lastCall?.[0].cameraProfile).toBeNull()
  panelTab('film')
  expect(
    screen.getByText('Kodak Ektachrome 100', { selector: '[data-sidebar-page] *' })
  ).toBeTruthy()
})

it('does not offer an uncalibrated Aerochrome preview when FCBlue is missing', async () => {
  editor.setState({ session: { ...editor.getState().session!, sessionId: 'no-fcblue' } })
  render(<Controls />)
  picker(t('editor.filmStock'))
  const button = screen.getByRole('button', { name: t('editor.aerochrome') }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(screen.getByText(t('editor.aerochromeHelp'), { exact: false }).textContent).toContain(
    t('editor.aerochromeUnavailable')
  )
  fireEvent.click(button)
  expect(change).not.toHaveBeenCalled()
  await waitFor(() => expect(renderThumbnail).toHaveBeenCalled())
  expect(renderThumbnail.mock.calls.some(([recipe]) => recipe.cameraProfile === 'FCBlue')).toBe(
    false
  )
})

it('identifies saved Aerochrome edits and explains the fallback on a camera without FCBlue', () => {
  const pasted = pasteRecipe(
    {
      ...defaultRecipe(),
      cameraProfile: 'FCBlue',
      film: { ...DEFAULT_FILM, film: 15, negative: true }
    },
    defaultRecipe()
  )
  render(<Controls initial={pasted} />)
  panelTab('film')
  expect(
    screen.getByText(t('editor.aerochrome'), { selector: '[data-sidebar-page] *' })
  ).toBeTruthy()
  picker(t('editor.filmStock'))
  const button = screen.getByRole('button', { name: t('editor.aerochrome') }) as HTMLButtonElement
  expect(button.ariaPressed).toBe('true')
  expect(button.disabled).toBe(true)
  expect(screen.getByText(t('editor.aerochromeHelp'), { exact: false }).textContent).toContain(
    t('editor.aerochromeUnavailable')
  )
})

const whiteBalance = (): HTMLElement =>
  screen.getByRole('button', { name: t('editor.whiteBalancePreset') })

it('starts white balance from the camera reading so leaving As shot does not jump', async () => {
  render(<Controls />)
  expect(
    screen.getByRole('slider', { name: t('editor.temperature') }).getAttribute('aria-valuenow')
  ).toBe('5150')
  expect(whiteBalance().textContent).toBe(t('editor.asShot'))
  adjust(t('editor.temperature'), 5600)
  expect(change).toHaveBeenLastCalledWith({ temperature: 5600, tint: 7 }, true)
  adjust(t('editor.temperature'), 6000)
  expect(change).toHaveBeenLastCalledWith({ temperature: 6000 }, true)
  invoke.mockResolvedValueOnce('asShot')
  fireEvent.click(whiteBalance())
  await waitFor(() => expect(change).toHaveBeenLastCalledWith({ temperature: null, tint: 0 }))
})

it('offers white balance presets in a menu between the picker and reset icons', async () => {
  render(<Controls />)
  invoke.mockResolvedValueOnce('tungsten')
  fireEvent.click(whiteBalance())
  await waitFor(() => expect(change).toHaveBeenLastCalledWith({ temperature: 2850, tint: 0 }))
  act(() => setRecipe({ ...defaultRecipe(), temperature: 7500 }))
  expect(whiteBalance().textContent).toBe(t('editor.shade'))
  // A tint makes it a custom balance. The menu names it but cannot select it.
  act(() => setRecipe({ ...defaultRecipe(), temperature: 7500, tint: 4 }))
  expect(whiteBalance().textContent).toBe(t('editor.customWhiteBalance'))
  fireEvent.click(whiteBalance())
  const menu = invoke.mock.calls.filter(([channel]) => channel === 'menu:popup').at(-1)![1]
  expect(menu.items.at(-1)).toEqual({
    value: 'custom',
    label: t('editor.customWhiteBalance'),
    disabled: true,
    checked: true
  })
  await waitFor(() => expect(whiteBalance().getAttribute('aria-expanded')).toBe('false'))
  const picker = screen.getByRole('button', { name: t('editor.picker') })
  expect(picker.textContent).toBe('')
  expect(picker.getAttribute('aria-keyshortcuts')).toBe('W')
  expect(picker.nextElementSibling).toBe(whiteBalance())
  const reset = screen.getByRole('button', { name: t('editor.resetWhiteBalance') })
  expect(whiteBalance().nextElementSibling).toBe(reset)
  fireEvent.click(reset)
  expect(change).toHaveBeenLastCalledWith({ temperature: null, tint: 0 })
  act(() => setRecipe(defaultRecipe()))
  expect((reset as HTMLButtonElement).disabled).toBe(true)
})

it('extends the white balance range for infrared and full-spectrum photos', () => {
  render(<Controls />)
  const field = (name: string): HTMLInputElement => screen.getByRole('spinbutton', { name })
  adjust(t('editor.temperature'), 900)
  expect(change).toHaveBeenLastCalledWith({ temperature: 2000, tint: 7 }, true)
  fireEvent.click(screen.getByRole('switch', { name: t('editor.extendedRange') }))
  expect([field(t('editor.temperature')).min, field(t('editor.temperature')).max]).toEqual([
    '500',
    '50000'
  ])
  expect(field(t('editor.tint')).min).toBe('-2000')
  adjust(t('editor.temperature'), 900)
  expect(change).toHaveBeenLastCalledWith({ temperature: 900 }, true)
  // The slider moves by ratio, so one step is about 1% at any temperature.
  const slider = screen.getByRole('slider', { name: t('editor.temperature') })
  expect(slider.getAttribute('aria-valuetext')).toBe('900')
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  expect(change).toHaveBeenLastCalledWith({ temperature: 910 }, true)
  // Values where a rounded position used to give back the same value.
  for (const [from, key, to] of [
    [560, 'ArrowRight', 570],
    [560, 'ArrowLeft', 550],
    [6000, 'ArrowRight', 6060],
    [6000, 'PageUp', 6630]
  ] as const) {
    act(() => setRecipe({ ...defaultRecipe(), temperature: from }))
    fireEvent.keyDown(screen.getByRole('slider', { name: t('editor.temperature') }), { key })
    expect(change).toHaveBeenLastCalledWith({ temperature: to }, true)
  }
  // As shot, Tint is a green gain and keeps its normal range.
  act(() => setRecipe(defaultRecipe()))
  expect(field(t('editor.tint')).min).toBe('-100')
  // An out-of-range value enables Extended Range for both controls.
  fireEvent.click(screen.getByRole('switch', { name: t('editor.extendedRange') }))
  act(() => setRecipe({ ...defaultRecipe(), temperature: 5000, tint: -700 }))
  expect(field(t('editor.temperature')).max).toBe('50000')
  expect(field(t('editor.tint')).min).toBe('-2000')
  expect(
    screen.getByRole('slider', { name: t('editor.tint') }).getAttribute('aria-valuetext')
  ).toBe('-700')
})

it.each([{ temperature: 1990 }, { temperature: 12010 }, { tint: -101 }, { tint: 101 }])(
  'shows Extended Range for loaded or picked white balance %o',
  (balance) => {
    const field = (name: string): HTMLInputElement => screen.getByRole('spinbutton', { name })
    render(<Controls initial={{ ...defaultRecipe(), temperature: 6500, ...balance }} />)
    const toggle = (): HTMLElement =>
      screen.getByRole('switch', { name: t('editor.extendedRange') })
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(field(t('editor.temperature')).min).toBe('500')
    expect(field(t('editor.tint')).min).toBe('-2000')
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(change).not.toHaveBeenCalled()
    act(() => setRecipe(defaultRecipe()))
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    act(() => setRecipe({ ...defaultRecipe(), ...balance }))
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  }
)

it('allows manual Extended Range changes within the normal white balance limits', () => {
  render(<Controls initial={{ ...defaultRecipe(), temperature: 2000, tint: -100 }} />)
  const toggle = (): HTMLElement => screen.getByRole('switch', { name: t('editor.extendedRange') })
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle())
  act(() => setRecipe({ ...defaultRecipe(), temperature: 12000, tint: 100 }))
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle())
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(change).not.toHaveBeenCalled()
})

it('keeps an extended slider extended while a drag brings it into the normal range', () => {
  render(<Controls initial={{ ...defaultRecipe(), temperature: 1500 }} />)
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
    const thumb = (): HTMLElement => screen.getByRole('slider', { name: t('editor.temperature') })
    const root = thumb().closest('[data-orientation]')!.parentElement!.closest('[data-orientation]')
    const track = root ?? thumb().closest('[data-orientation]')!
    fireEvent.pointerDown(track, { clientX: 30, pointerId: 1, button: 0 })
    expect(change.mock.lastCall![0].temperature).toBeLessThan(2000)
    // On the log scale, 41% of the track is about 3300 K. A linear slider would give 6000 K.
    fireEvent.pointerMove(track, { clientX: 40, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 41, pointerId: 1 })
    const temperature = change.mock.lastCall![0].temperature
    expect(temperature).toBeGreaterThan(2000)
    expect(temperature).toBeLessThan(4000)
    fireEvent.pointerUp(track, { clientX: 41, pointerId: 1 })
    expect(thumb().getAttribute('aria-valuemax')).toBe('12000')
  } finally {
    rect.mockRestore()
    for (const [k, v] of saved) proto[k as string] = v
  }
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
  panelTab('raw')
  act(() => editor.setState({ closing: true }))
  change.mockClear()
  reset(t('editor.temperature'))
  expect(change).not.toHaveBeenCalled()
})

it('resets a slider on Shift-click of its label, which reads Reset while Shift is held', () => {
  render(<Controls initial={{ ...defaultRecipe(), tint: 30 }} />)
  // Double-clicking the knob and Shift-clicking the label replace the reset buttons.
  expect(
    screen.queryByRole('button', { name: `${t('editor.reset')} ${t('editor.tint')}` })
  ).toBeNull()
  const name = screen.getByText(t('editor.tint'), { selector: '.control-label > span' })
  const label = name.parentElement!
  // Both texts stay in the label, so its width cannot change under the pointer.
  const resetText = within(label).getByText(t('editor.reset'))
  const shows = (text: HTMLElement): boolean => !text.classList.contains('invisible')
  fireEvent.pointerEnter(label)
  fireEvent.click(label)
  expect(change).not.toHaveBeenCalled()
  expect([shows(name), shows(resetText)]).toEqual([true, false])
  fireEvent.keyDown(window, { key: 'Shift', shiftKey: true })
  expect([shows(name), shows(resetText)]).toEqual([false, true])
  // The row's help icon hides by CSS while the label is marked.
  expect(label.hasAttribute('data-resetting')).toBe(true)
  fireEvent.click(label, { shiftKey: true })
  expect(change).toHaveBeenLastCalledWith({ tint: 0 })
  fireEvent.keyUp(window, { key: 'Shift', shiftKey: false })
  expect([shows(name), shows(resetText)]).toEqual([true, false])
  expect(label.hasAttribute('data-resetting')).toBe(false)
  const help = screen.getByRole('button', { name: t('editor.fillLight') })
  expect(help.closest('.group\\/reset')).not.toBeNull()
  expect(help.className).toContain('group-has-[[data-resetting]]/reset:invisible')
  fireEvent.keyDown(window, { key: 'Shift', shiftKey: true })
  fireEvent.pointerLeave(label)
  expect([shows(name), shows(resetText)]).toEqual([true, false]) // Delete on the focused slider is the keyboard reset.
  change.mockClear()
  fireEvent.keyDown(screen.getByRole('slider', { name: t('editor.tint') }), { key: 'Delete' })
  expect(change).toHaveBeenLastCalledWith({ tint: 0 })
})

it('offers Negative print among the papers, with a Negative preview toggle below it', () => {
  render(<Controls />)
  darkroom()
  expect(screen.queryByRole('switch', { name: t('editor.negativePreview') })).toBeNull()
  fireEvent.click(
    within(picker(t('editor.paperStock'))).getByRole('button', { name: t('editor.negativePrint') })
  )
  expect(film()).toMatchObject({ negative: true, paper: DEFAULT_FILM.paper })
  darkroom()
  // The paper box names the choice, and the print controls leave.
  const paper = screen.getByText(t('editor.negativePrint'), { selector: '[data-sidebar-page] *' })
  const preview = screen.getByRole('switch', { name: t('editor.negativePreview') })
  expect(paper.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.queryByRole('slider', { name: t('editor.evPaper') })).toBeNull()
  // The toggle only changes the view; the recipe stays the same.
  change.mockClear()
  fireEvent.click(preview)
  expect(editor.getState().negativePreview).toBe(true)
  expect(change).not.toHaveBeenCalled()
  act(() => editor.setState({ negativePreview: false }))
  // Choosing a paper prints the negative again.
  fireEvent.click(
    within(picker(t('editor.paperStock'))).getAllByRole('button', { pressed: false })[0]
  )
  expect(film()?.negative).toBe(false)
})

it('maps the darkroom sliders so dragging right does what the label says', () => {
  render(<Controls />)
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

it('keeps legacy grain when choosing another stock or the Aerochrome look', () => {
  editor.setState({
    session: {
      ...editor.getState().session!,
      cameraProfiles: [{ id: 'FCBlue', name: 'FOV Classic Blue' }]
    }
  })
  render(
    <Controls
      initial={{
        ...defaultRecipe(),
        film: {
          ...DEFAULT_FILM,
          grainParams: null,
          halationParams: null,
          grainAmount: 3,
          grainSize: 2,
          grainRoughness: 0.4
        }
      }}
    />
  )
  for (const name of ['Kodak Gold 200', t('editor.aerochrome')]) {
    chooseFilm(name)
    expect(film()).toMatchObject({
      grainParams: null,
      halationParams: null,
      grainAmount: 3,
      grainSize: 2,
      grainRoughness: 0.4
    })
  }
})

it('adjusts color ranges in the color mixer and edits curve points from the keyboard', () => {
  const view = render(<Controls />)
  panelTab('grading')
  expect(sections(view.container).slice(0, 2)).toEqual([t('editor.color'), t('editor.colorMixer')])
  // Grain channel offsets also have a Blue slider.
  const mixer = within(screen.getByRole('tabpanel', { name: t('editor.hue') }))
  fireEvent.change(mixer.getByRole('spinbutton', { name: t('editor.blue') }), {
    target: { value: '40' }
  })
  expect(change.mock.lastCall?.[0].hsl[5]).toEqual({ hue: 40, saturation: 0, luminance: 0 })
  panelTab('raw')
  fireEvent.click(swatch(t('editor.curveChannel'), t('editor.red')))
  fireEvent.click(screen.getByRole('button', { name: t('editor.addPoint') }))
  const point = screen.getByRole('slider', { name: `${t('editor.curvePoint')} 2` })
  fireEvent.keyDown(point, { key: 'ArrowUp' })
  expect(change.mock.lastCall?.[0].curves.red[1].y).toBeCloseTo(0.51)
  const curve = screen
    .getByRole('group', { name: t('editor.curves') })
    .querySelector('path[stroke-width="2"]')!
  expect(curve.getAttribute('d')).toContain(' C ')
  expect(curve.getAttribute('d')).toContain('100 98')
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
  const orientation = (name: string): HTMLElement =>
    within(screen.getByRole('group', { name: t('editor.orientation') })).getByRole('button', {
      name
    })
  expect(orientation(t('editor.portrait')).getAttribute('aria-pressed')).toBe('true')
  expect(orientation(t('editor.landscape')).getAttribute('aria-pressed')).toBe('false')
  // Choosing the current orientation again changes nothing.
  change.mockClear()
  fireEvent.click(orientation(t('editor.portrait')))
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(orientation(t('editor.landscape')))
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
  expect(view.container.querySelector('image')!.getAttribute('filter')).toBeNull()
  // A negative preview inverts the picture only, not the frame drawn over it.
  view.rerender(
    <CropPreview preview={preview} recipe={defaultRecipe()} locked inverted onDone={() => {}} />
  )
  expect(view.container.querySelector('image')!.getAttribute('filter')).toBe('url(#crop-invert)')
  expect(view.container.querySelector('rect')!.getAttribute('filter')).toBeNull()
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
  panelTab('film')
  expect(screen.getByText(t('editor.standard'), { selector: '[data-sidebar-page] *' })).toBeTruthy()
  picker(t('editor.filmStock'))
  expect(screen.getByRole('button', { name: t('editor.standard'), exact: true }).ariaPressed).toBe(
    'true'
  )
  expect(screen.queryByRole('button', { name: 'FOV Blue' })).toBeNull()
})
