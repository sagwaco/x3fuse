// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  DEFAULT_EFFECTS,
  DEFAULT_FILM,
  defaultRecipe,
  filmGrainDefaults,
  type EditRecipe
} from '@shared/editor'
import type { NativeMenuRequest } from '@shared/ipc'
import { EDITOR_SECTIONS, resetSection, type SectionId } from '@shared/editorSections'
import { EditorControls, Section } from '../src/renderer/src/components/EditorControls'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { t } from '../src/renderer/src/lib/strings'

/** Changes every value: numbers grow, flags flip, and nulls become numbers. */
const perturb = (value: unknown): unknown =>
  typeof value === 'number'
    ? value + 1
    : typeof value === 'boolean'
      ? !value
      : value === null
        ? 1
        : Array.isArray(value)
          ? value.map(perturb)
          : typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, perturb(item)]))
            : value
/** The recipe fields that differ, with film settings as `film.<key>`. */
function changed(before: object, after: object, nested = true): string[] {
  const a = before as Record<string, unknown>
  const b = after as Record<string, unknown>
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .flatMap((key) => {
      const [x, y] = [a[key], b[key]] as [object, object]
      if (nested && key === 'film' && x && y)
        return changed(x, y, false).map((field) => `film.${field}`)
      return JSON.stringify(x) === JSON.stringify(y) ? [] : [key]
    })
    .sort()
}
const LOOK = ['film', 'paper', 'negative', 'evPaper', 'couplers', 'couplersRadius']
const PRINT = ['gammaFilm', 'gammaPaper', 'tuneM', 'tuneY']
const EFFECTS = [
  'grain',
  'grainParams',
  'grainSize',
  'grainAmount',
  'grainRoughness',
  'grainSaturation',
  'halation',
  'halationParams',
  'halationStrength',
  'halationRadius',
  'halationMidtones',
  'scatterSizeRgb',
  'scatterStrengthRgb',
  'halationSizeRgb',
  'halationStrengthRgb'
]
const film = (keys: string[]): string[] => keys.map((key) => `film.${key}`)

describe('editor sections', () => {
  const to = defaultRecipe()
  const from = {
    ...(perturb(to) as EditRecipe),
    cameraProfile: 'Landscape',
    temperature: 4000,
    crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    effects: { ...DEFAULT_EFFECTS, grain: true },
    monochrome: { filter: 'red' as const },
    warmth: 10,
    toneMixer: [1, 2, 3, 4, 5, 6, 7, 8]
  }
  const expected: Record<SectionId, string[]> = {
    light: [
      'blacks',
      'contrast',
      'exposure',
      'fillLight',
      'highlights',
      'shadows',
      'whites',
      'film.evFilm'
    ],
    curves: ['curves'],
    whiteBalance: ['temperature', 'tint'],
    detail: ['denoise', 'denoiseOptions', 'sharpen'],
    look: ['cameraProfile', 'monochrome', ...film([...LOOK, ...PRINT])],
    effects: film(EFFECTS),
    filter: ['monochrome'],
    color: ['saturation', 'vibrance', 'warmth'],
    toneMixer: ['toneMixer'],
    colorMixer: ['hsl'],
    colorWheels: ['wheels']
  }

  it.each(Object.keys(expected) as SectionId[])('%s pastes only its own settings', (id) => {
    const after = { ...to, ...EDITOR_SECTIONS[id].take(from, to) }
    expect(changed(to, after)).toEqual(expected[id].sort())
  })

  it('moves effects and film exposure between film and camera looks', () => {
    const camera = { ...to, film: null }
    expect(EDITOR_SECTIONS.effects.take(to, camera)).toEqual({
      effects: {
        grain: DEFAULT_FILM.grain,
        grainParams: DEFAULT_FILM.grainParams,
        halation: DEFAULT_FILM.halation,
        halationParams: DEFAULT_FILM.halationParams
      }
    })
    const withEffects = { ...camera, ...EDITOR_SECTIONS.effects.take(from, camera) }
    expect(changed(camera, withEffects)).toEqual(['effects'])
    // A film look on a camera look brings its exposure and effects along.
    expect(EDITOR_SECTIONS.look.take(from, camera).film).toEqual(from.film)
    expect(changed(camera, { ...camera, ...EDITOR_SECTIONS.light.take(from, camera) })).toEqual([
      'blacks',
      'contrast',
      'exposure',
      'fillLight',
      'highlights',
      'shadows',
      'whites'
    ])
  })

  it('resets Light with a film look and keeps the stock, paper, and effects', () => {
    const recipe = { ...from, film: { ...from.film!, evFilm: 1.5 } }
    const defaults = { ...defaultRecipe(), film: null }
    const after = { ...recipe, ...resetSection(EDITOR_SECTIONS.light, recipe, defaults) }
    expect(after.film).toEqual({ ...recipe.film, evFilm: DEFAULT_FILM.evFilm })
    expect(after.exposure).toBe(0)
    expect(changed(recipe, after)).toEqual(expected.light.sort())
  })

  it('resets the effects to the defaults of the stock, and the look to the camera', () => {
    const recipe = { ...to, film: { ...from.film!, film: DEFAULT_FILM.film } }
    const defaults = { ...defaultRecipe(), film: null, cameraProfile: 'Standard' }
    const effects = { ...recipe, ...resetSection(EDITOR_SECTIONS.effects, recipe, defaults) }
    expect(effects.film).toMatchObject({
      film: DEFAULT_FILM.film,
      evFilm: recipe.film.evFilm,
      paper: recipe.film.paper,
      grain: DEFAULT_FILM.grain,
      grainParams: filmGrainDefaults(DEFAULT_FILM.film),
      halationParams: DEFAULT_FILM.halationParams
    })
    expect(resetSection(EDITOR_SECTIONS.effects, from, defaults)).not.toHaveProperty('effects')
    const camera = { ...to, film: null, effects: DEFAULT_EFFECTS }
    expect(resetSection(EDITOR_SECTIONS.effects, camera, defaults)).toEqual({ effects: null })
    expect(resetSection(EDITOR_SECTIONS.look, recipe, defaults)).toEqual({
      cameraProfile: 'Standard',
      monochrome: null,
      film: null
    })
  })
})

describe('section menus', () => {
  let choice: string | null = null
  const invoke = vi.fn(async (channel: string, _payload?: unknown) =>
    channel === 'menu:popup' ? choice : null
  )
  const change = vi.fn()
  const request = (): NativeMenuRequest =>
    invoke.mock.calls
      .filter(([channel]) => channel === 'menu:popup')
      .at(-1)![1] as NativeMenuRequest
  const recipe = { ...defaultRecipe(), exposure: 1, contrast: 20, temperature: 4000 }
  const header = (name: string): HTMLElement => screen.getByText(name, { selector: 'summary' })
  async function open(name: string, value: string | null, init: object = {}): Promise<void> {
    choice = value
    await act(async () => {
      fireEvent.contextMenu(header(name), { clientX: 10, clientY: 20, ...init })
    })
  }

  beforeEach(() => {
    vi.stubGlobal('x3f', { invoke, on: () => () => {} })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    invoke.mockClear()
    change.mockReset()
    queue.setState({ isProcessing: false, isPreparing: false })
    editor.setState({
      session: { sessionId: 'menu', path: '/a.X3F', recipe, revision: 0 },
      documents: { '/a.X3F': { recipe, revision: 0, past: [], future: [], dirty: false } },
      preview: { sessionId: 'menu', revision: 0, url: 'preview', width: 3, height: 2 },
      loading: false,
      closing: false,
      before: false,
      change
    })
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.unstubAllGlobals()
  })
  const panel = (
    <div role="tabpanel">
      <Section id="light" name="Light">
        <button>Exposure</button>
      </Section>
      <Section id="whiteBalance" name="White balance">
        <button>Temperature</button>
      </Section>
      <Section id="export-output" name="Output">
        <button>Folder</button>
      </Section>
    </div>
  )

  it('resets, copies, and pastes the settings of one section', async () => {
    render(panel)
    await open('Light', 'reset')
    expect(request()).toMatchObject({
      x: 10,
      y: 20,
      items: [
        { value: 'reset', label: t('context.reset_section', { name: 'Light' }), disabled: false },
        { value: 'copy', label: t('context.copy_section', { name: 'Light' }), disabled: false },
        { value: 'paste', label: t('context.paste_section', { name: 'Light' }), disabled: true },
        { value: 'expand', label: t('context.expand_all'), separatorBefore: true },
        { value: 'collapse', label: t('context.collapse_all') }
      ]
    })
    // The film keeps its stock; only its exposure resets.
    expect(change).toHaveBeenLastCalledWith({
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      fillLight: 0,
      film: { ...recipe.film, evFilm: DEFAULT_FILM.evFilm }
    })
    await open('Light', 'copy')
    // A copy pastes only into the same section.
    await open('White balance', 'paste')
    expect(request().items[2]).toMatchObject({ value: 'paste', disabled: true })
    expect(change).toHaveBeenCalledOnce()
    await open('Light', 'paste')
    expect(change).toHaveBeenLastCalledWith(EDITOR_SECTIONS.light.take(recipe, recipe))
  })

  it('resets on Option-click without a toggle, and opens from the Menu key', async () => {
    render(panel)
    const details = header('White balance').parentElement as HTMLDetailsElement
    expect(details.open).toBe(true)
    fireEvent.click(header('White balance'), { altKey: true })
    expect(details.open).toBe(true)
    expect(change).toHaveBeenLastCalledWith({ temperature: null, tint: 0 })
    choice = null
    await act(async () => {
      fireEvent.keyDown(header('White balance'), { key: 'F10', shiftKey: true })
    })
    expect(request().items[0].label).toBe(t('context.reset_section', { name: 'White balance' }))
  })

  it('collapses and expands every section of the panel', async () => {
    render(panel)
    const sections = [...document.querySelectorAll('details')]
    await open('Light', 'collapse')
    expect(sections.map((section) => section.open)).toEqual([false, false, false])
    await open('White balance', 'expand')
    expect(sections.map((section) => section.open)).toEqual([true, true, true])
  })

  it('disables the settings items in Before, and leaves other sections without a menu', async () => {
    editor.setState({ before: true })
    render(panel)
    await open('Light', 'reset')
    expect(
      request()
        .items.slice(0, 3)
        .map((item) => item.disabled)
    ).toEqual([true, true, true])
    fireEvent.click(header('Light'), { altKey: true })
    expect(change).not.toHaveBeenCalled()
    invoke.mockClear()
    expect(fireEvent.contextMenu(header('Output'))).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('removes a curve point or resets the curve from the curve menu', async () => {
    const master = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.6 },
      { x: 1, y: 1 }
    ]
    const curved = { ...recipe, film: null, curves: { ...recipe.curves, master } }
    render(
      <EditorControls recipe={curved} picking={false} setPicking={() => {}} onNavigate={() => {}} />
    )
    const curve = screen.getByRole('group', { name: t('editor.curves') })
    curve.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect
    // A secondary click opens the menu without adding a point.
    fireEvent.pointerDown(curve, { button: 2, clientX: 50, clientY: 100 })
    expect(change).not.toHaveBeenCalled()
    choice = 'remove'
    await act(async () => {
      fireEvent.contextMenu(curve, { clientX: 100, clientY: 80 })
    })
    expect(request().items).toEqual([{ value: 'remove', label: t('editor.removePoint') }])
    expect(change).toHaveBeenLastCalledWith(
      { curves: { ...curved.curves, master: [master[0], master[2]] } },
      true
    )
    choice = 'reset'
    await act(async () => {
      fireEvent.contextMenu(curve, { clientX: 150, clientY: 100 })
    })
    expect(request().items).toEqual([{ value: 'reset', label: t('editor.resetCurve') }])
    expect(change).toHaveBeenLastCalledWith(
      { curves: { ...curved.curves, master: defaultRecipe().curves.master } },
      true
    )
  })
})

describe('the WebKit menu', () => {
  it('shows only on text fields and selected text', async () => {
    const { suppressDefaultMenu } = await vi.importActual<
      typeof import('../src/renderer/src/lib/nativeMenu')
    >('../src/renderer/src/lib/nativeMenu')
    window.addEventListener('contextmenu', suppressDefaultMenu)
    const page = document.body.appendChild(document.createElement('div'))
    page.innerHTML = '<p>Text</p><input aria-label="Name"><textarea></textarea>'
    expect(fireEvent.contextMenu(page.querySelector('p')!)).toBe(false)
    expect(fireEvent.contextMenu(page.querySelector('input')!)).toBe(true)
    expect(fireEvent.contextMenu(page.querySelector('textarea')!)).toBe(true)
    window.getSelection()!.selectAllChildren(page.querySelector('p')!)
    expect(fireEvent.contextMenu(page.querySelector('p')!)).toBe(true)
    window.getSelection()!.removeAllRanges()
    window.removeEventListener('contextmenu', suppressDefaultMenu)
    page.remove()
  })
})
