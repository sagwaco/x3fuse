// @vitest-environment jsdom
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  DEFAULT_EFFECTS,
  DEFAULT_FILM,
  defaultRecipe,
  filmGrainDefaults,
  type EditRecipe
} from '@shared/editor'
import { LookPicker } from '../src/renderer/src/components/LookPicker'
import { EffectsSection } from '../src/renderer/src/components/EffectsControls'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { t } from '../src/renderer/src/lib/strings'

const originalChange = editor.getState().change
const originalCommit = editor.getState().commit
const change = vi.fn()
const commit = vi.fn()
let setRecipe: Dispatch<SetStateAction<EditRecipe>>
function Effects({ initial = defaultRecipe() }: { initial?: EditRecipe }): React.JSX.Element {
  const [recipe, update] = useState(initial)
  setRecipe = update
  // A section reset reads the recipe of the open photo.
  useEffect(() => editor.setState({ documents: { '/a.X3F': { recipe } } } as never), [recipe])
  return <EffectsSection recipe={recipe} />
}
const lookRecipe = (): EditRecipe => ({ ...defaultRecipe(), film: null })
function reset(label: string): void {
  fireEvent.doubleClick(screen.getByRole('slider', { name: label }))
}
function adjust(label: string, value: number): void {
  fireEvent.change(screen.getByRole('spinbutton', { name: label }), {
    target: { value: String(value) }
  })
}
const header = (effect: 'grain' | 'halation'): HTMLElement =>
  screen.getByText(t(`editor.${effect}`), { selector: 'summary' })
/** Option-click on the section header resets the section. */
function resetSection(effect: 'grain' | 'halation'): void {
  fireEvent.click(header(effect), { altKey: true })
}
const film = (): EditRecipe['film'] => change.mock.lastCall?.[0].film
const effects = (): EditRecipe['effects'] => change.mock.lastCall?.[0].effects
const toggle = (effect: 'grain' | 'halation'): HTMLButtonElement =>
  screen.getByRole('switch', {
    name: t(effect === 'grain' ? 'editor.enableGrain' : 'editor.enableHalation')
  }) as HTMLButtonElement

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
    before: false,
    change,
    commit
  })
})
afterEach(() => {
  cleanup()
  editor.setState({
    change: originalChange,
    commit: originalCommit,
    session: null,
    preview: null
  })
  vi.unstubAllGlobals()
})

it.each(['grain', 'halation'] as const)(
  'resets %s with Option-click on the header and guards disabled resets',
  (effect) => {
    const recipe = defaultRecipe()
    recipe.film!.grainParams!.blur = 2
    recipe.film!.halationParams!.halationAmount = 3
    render(<Effects initial={recipe} />)
    const key = effect === 'grain' ? 'grainParams' : 'halationParams'
    fireEvent.click(header(effect))
    expect(change).not.toHaveBeenCalled()
    resetSection(effect)
    expect(film()?.[effect]).toBe(recipe.film![effect])
    expect(film()?.[key]).toEqual(DEFAULT_FILM[key])
    act(() => editor.setState({ closing: true }))
    change.mockClear()
    resetSection(effect)
    expect(change).not.toHaveBeenCalled()
  }
)

it('puts each switch in its section, also while the effect is off, with halation help after its label', () => {
  for (const recipe of [defaultRecipe(), lookRecipe()]) {
    const view = render(<Effects initial={recipe} />)
    for (const effect of ['grain', 'halation'] as const) {
      const section = header(effect).closest('details')!
      expect(header(effect).querySelector('button')).toBeNull()
      expect(section.contains(toggle(effect))).toBe(true)
    }
    const label = screen.getByText(t('editor.enableHalation'), { selector: 'span' })
    expect(label.querySelector('button')!.getAttribute('aria-label')).toBe(
      t('editor.enableHalation')
    )
    expect(
      screen.getByText(t('editor.enableGrain'), { selector: 'span' }).querySelector('button')
    ).toBeNull()
    view.unmount()
  }
})

it('moves all grain channels with the main slider and changes offsets independently', () => {
  render(<Effects />)
  adjust(t('editor.grainRmsGranularity'), 12)
  expect(film()?.grainParams).toMatchObject({ rmsBase: 12, rmsGranularity: [12, 12, 12] })
  const offsets = screen
    .getByText(t('editor.grainChannelOffsets'), { selector: 'summary' })
    .closest('details')!
  expect(offsets.open).toBe(true)
  adjust(t('editor.red'), 2)
  adjust(t('editor.green'), -3)
  expect(film()?.grainParams).toMatchObject({ rmsBase: 12, rmsGranularity: [14, 9, 12] })
  adjust(t('editor.grainRmsGranularity'), 20)
  expect(film()?.grainParams?.rmsGranularity).toEqual([22, 17, 20])
  adjust(t('editor.grainBlur'), 1.2)
  adjust(t('editor.grainSharpen'), 0)
  expect(film()?.grainParams).toMatchObject({ blur: 1.2, multUsmAmount: 0 })
  reset(t('editor.red'))
  expect(film()?.grainParams?.rmsGranularity).toEqual([20, 17, 20])
  fireEvent.click(toggle('grain'))
  expect(film()?.grain).toBe(false)
  expect(screen.queryByRole('slider', { name: t('editor.grainBlur') })).toBeNull()
  resetSection('grain')
  expect(film()).toMatchObject({ grain: false, grainParams: filmGrainDefaults(2) })
})

it('preserves grain offsets at both bounds and restores them from a saved recipe', () => {
  const saved = defaultRecipe()
  saved.film!.grainParams = { ...filmGrainDefaults(2), rmsBase: 12, rmsGranularity: [14, 9, 12] }
  render(<Effects initial={JSON.parse(JSON.stringify(saved))} />)
  adjust(t('editor.grainRmsGranularity'), 100)
  expect(film()?.grainParams).toMatchObject({ rmsBase: 98, rmsGranularity: [100, 95, 98] })
  adjust(t('editor.grainRmsGranularity'), 0)
  expect(film()?.grainParams).toMatchObject({ rmsBase: 3, rmsGranularity: [5, 0, 3] })
  act(() => setRecipe(saved))
  expect(
    (screen.getByRole('spinbutton', { name: t('editor.grainRmsGranularity') }) as HTMLInputElement)
      .value
  ).toBe('12')
  reset(t('editor.grainRmsGranularity'))
  expect(film()?.grainParams).toEqual(filmGrainDefaults(2))
})

it('uses the full main grain range for black-and-white film with unequal saved channels', () => {
  const saved = defaultRecipe()
  saved.film = {
    ...saved.film!,
    film: 21,
    grainParams: { ...filmGrainDefaults(21), rmsGranularity: [25, 44, 44] }
  }
  render(<Effects initial={saved} />)
  expect(screen.queryByText(t('editor.grainChannelOffsets'))).toBeNull()
  adjust(t('editor.grainRmsGranularity'), 100)
  expect(film()?.grainParams?.rmsGranularity).toEqual([100, 100, 100])
})

it('keeps scatter and halation amount and size independent', () => {
  render(<Effects />)
  expect(screen.queryByRole('slider', { name: t('editor.halationAmount') })).toBeNull()
  fireEvent.click(toggle('halation'))
  adjust(t('editor.halationAmount'), 2)
  expect(film()?.halationParams).toEqual({
    scatterAmount: 1,
    scatterSpatialScale: 1,
    halationAmount: 2,
    halationSpatialScale: 1
  })
  adjust(t('editor.halationSpatialScale'), 3)
  adjust(t('editor.scatterAmount'), 0.5)
  adjust(t('editor.scatterSpatialScale'), 2)
  adjust(t('editor.halationAmount'), 0)
  expect(film()).toMatchObject({
    halation: true,
    halationParams: {
      scatterAmount: 0.5,
      scatterSpatialScale: 2,
      halationAmount: 0,
      halationSpatialScale: 3
    }
  })
  reset(t('editor.halationAmount'))
  expect(film()?.halationParams?.halationAmount).toBe(1)
  expect(film()?.halationParams?.halationSpatialScale).toBe(3)
  resetSection('halation')
  expect(film()?.halationParams).toEqual(DEFAULT_FILM.halationParams)
})

it('preserves saved legacy effects until each effect is explicitly reset', () => {
  const recipe = defaultRecipe()
  Object.assign(recipe.film!, {
    grainParams: null,
    halationParams: null,
    grainAmount: 4,
    grainSize: 2,
    grainRoughness: 0.6,
    halation: true,
    halationStrength: 1,
    halationRadius: 0.004,
    halationMidtones: 0.5
  })
  render(<Effects initial={recipe} />)
  expect(change).not.toHaveBeenCalled()
  expect(screen.getAllByText(t('editor.legacyFilmEffect'))).toHaveLength(2)
  expect(screen.queryByRole('slider', { name: t('editor.grainBlur') })).toBeNull()
  expect(screen.queryByRole('slider', { name: t('editor.halationAmount') })).toBeNull()
  resetSection('grain')
  expect(film()).toMatchObject({
    grainParams: filmGrainDefaults(2),
    grainAmount: 1,
    grainSize: 1,
    grainRoughness: 0,
    halationParams: null,
    halationRadius: 0.004
  })
  resetSection('halation')
  expect(film()?.halationParams).toEqual(DEFAULT_FILM.halationParams)
})

it('keeps effects off during reset and enables them only through native switches', () => {
  const recipe = defaultRecipe()
  Object.assign(recipe.film!, {
    grain: false,
    grainAmount: 0,
    grainParams: null,
    halation: false,
    halationStrength: 0,
    halationParams: null
  })
  render(<Effects initial={recipe} />)
  for (const effect of ['grain', 'halation'] as const) {
    expect(toggle(effect).disabled).toBe(true)
    fireEvent.click(toggle(effect))
  }
  expect(change).not.toHaveBeenCalled()
  resetSection('grain')
  resetSection('halation')
  expect(film()).toMatchObject({ grain: false, halation: false })
  for (const effect of ['grain', 'halation'] as const) {
    expect(toggle(effect).disabled).toBe(false)
    fireEvent.click(toggle(effect))
  }
  expect(film()).toMatchObject({
    grain: true,
    halation: true,
    grainParams: filmGrainDefaults(2),
    halationParams: DEFAULT_FILM.halationParams
  })
})

it('starts both effects off without a film stock and writes recipe.effects', () => {
  render(<Effects initial={lookRecipe()} />)
  expect(toggle('grain').getAttribute('aria-checked')).toBe('false')
  expect(toggle('halation').getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByText(t('editor.legacyFilmEffect'))).toBeNull()
  fireEvent.click(toggle('grain'))
  expect(effects()).toEqual({ ...DEFAULT_EFFECTS, grain: true })
  expect(change.mock.lastCall?.[0].film).toBeUndefined()
  fireEvent.click(toggle('halation'))
  expect(effects()).toEqual({ ...DEFAULT_EFFECTS, grain: true, halation: true })
})

it('edits generic grain and halation sliders and resets them to the defaults', () => {
  render(<Effects initial={lookRecipe()} />)
  fireEvent.click(toggle('grain'))
  fireEvent.click(toggle('halation'))
  expect(screen.queryByText(t('editor.grainChannelOffsets'))).toBeNull()
  expect(
    (screen.getByRole('spinbutton', { name: t('editor.grainRmsGranularity') }) as HTMLInputElement)
      .value
  ).toBe('8')
  adjust(t('editor.grainRmsGranularity'), 12)
  expect(effects()?.grainParams).toMatchObject({ rmsBase: 12, rmsGranularity: [10, 12, 14] })
  adjust(t('editor.grainBlur'), 1.5)
  adjust(t('editor.grainSharpen'), 0)
  expect(effects()?.grainParams).toMatchObject({ blur: 1.5, multUsmAmount: 0 })
  adjust(t('editor.halationAmount'), 2)
  expect(effects()?.halationParams.halationAmount).toBe(2)
  resetSection('grain')
  expect(effects()?.grainParams).toEqual(DEFAULT_EFFECTS.grainParams)
  expect(effects()).toMatchObject({ grain: true, halation: true })
  resetSection('halation')
  expect(effects()?.halationParams).toEqual(DEFAULT_EFFECTS.halationParams)
})

it('shows every slider for a monochrome camera look', () => {
  render(<Effects initial={{ ...lookRecipe(), monochrome: { filter: 'none' } }} />)
  fireEvent.click(toggle('grain'))
  fireEvent.click(toggle('halation'))
  for (const key of [
    'grainRmsGranularity',
    'grainBlur',
    'grainSharpen',
    'scatterAmount',
    'scatterSpatialScale',
    'halationAmount',
    'halationSpatialScale'
  ])
    expect(screen.getByRole('slider', { name: t(`editor.${key}`) })).toBeTruthy()
})

it.each([
  [() => t('editor.grainRmsGranularity'), 'grainRmsGranularityHelp'],
  [() => t('editor.grainChannelOffsets'), 'grainChannelOffsetHelp'],
  [() => t('editor.grainBlur'), 'grainBlurHelp'],
  [() => t('editor.grainSharpen'), 'grainSharpenHelp'],
  [() => t('editor.scatterAmount'), 'scatterAmountHelp'],
  [() => t('editor.scatterSpatialScale'), 'scatterSpatialScaleHelp'],
  [() => t('editor.halationAmount'), 'halationAmountHelp'],
  [() => t('editor.halationSpatialScale'), 'halationSpatialScaleHelp']
] as const)('explains native effect slider %s', async (label, help) => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  render(<Effects initial={{ ...defaultRecipe(), film: { ...DEFAULT_FILM, halation: true } }} />)
  const button = screen.getByRole('button', { name: label() })
  fireEvent.pointerMove(button, { pointerType: 'mouse' })
  expect((await screen.findByRole('tooltip')).textContent).toBe(t(`editor.${help}`))
})

it('explains the channel offsets once, beside their title', () => {
  render(<Effects initial={defaultRecipe()} />)
  for (const channel of ['red', 'green', 'blue'])
    expect(screen.queryByRole('button', { name: t(`editor.${channel}`) })).toBeNull()
})

it('initializes a legacy effect with the reset button while its switch is disabled', () => {
  const recipe = defaultRecipe()
  Object.assign(recipe.film!, { grainParams: null })
  render(<Effects initial={recipe} />)
  expect(toggle('grain').disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: t('editor.resetGrain') }))
  expect(film()?.grainParams).toEqual(filmGrainDefaults(2))
})

it('loads stock grain defaults and preserves adjustments when selecting the active stock', async () => {
  const recipe = defaultRecipe()
  recipe.film!.grainParams = { rmsBase: 7, rmsGranularity: [9, 7, 5], blur: 1.2, multUsmAmount: 0 }
  function Both(): React.JSX.Element {
    const [current, update] = useState(recipe)
    setRecipe = update
    return (
      <>
        <LookPicker kind="film" recipe={current} gallery />
        <EffectsSection recipe={current} />
      </>
    )
  }
  render(<Both />)
  // The gallery shows one group of looks at a time.
  const choose = async (name: string, group?: string): Promise<void> => {
    if (group) {
      vi.stubGlobal('x3f', { invoke: () => Promise.resolve(group), on: () => () => {} })
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: t('editor.filmGroups') }))
      )
    }
    fireEvent.click(screen.getByRole('button', { name }))
  }
  await choose('Kodak Portra 400')
  expect(film()?.grainParams).toEqual(recipe.film!.grainParams)
  await choose('Kodak Gold 200')
  expect(film()?.grainParams?.rmsGranularity).toEqual([5, 5, 5])
  expect(film()?.grainParams?.rmsBase).toBeUndefined()
  expect(film()?.grainParams).toMatchObject({ blur: 1.2, multUsmAmount: 0 })
  await choose('Kodak Vision3 500T', 'cinemaFilm')
  expect(film()?.grainParams?.rmsGranularity).toEqual([9, 13, 30])
  await choose('Kodak Tri-X 7266', 'bwFilm')
  expect(film()?.grainParams?.rmsGranularity).toEqual([44, 44, 44])
  expect(screen.queryByRole('slider', { name: t('editor.green') })).toBeNull()
  adjust(t('editor.grainRmsGranularity'), 25)
  expect(film()?.grainParams?.rmsGranularity).toEqual([25, 25, 25])
  reset(t('editor.grainRmsGranularity'))
  expect(film()?.grainParams?.rmsGranularity).toEqual([44, 44, 44])
})
