// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  capabilitiesOf,
  defaultRecipe,
  demosaicsOf,
  hasWhiteBalance,
  monoDemosaic,
  pasteRecipe,
  sourceDefaultRecipe,
  supportedRecipe,
  type EditRecipe,
  type SourceCapabilities
} from '@shared/editor'
import { EDITOR_SECTIONS, pasteSection, resetSection } from '@shared/editorSections'
import { t } from '../src/renderer/src/lib/strings'

const invoke = vi.fn(async (_channel?: unknown, _payload?: unknown): Promise<unknown> => null)
;(window as unknown as { x3f: unknown }).x3f = { invoke, on: () => () => {} }
const { useEditorStore: editor, asShotRecipe } =
  await import('../src/renderer/src/stores/editorStore')
const { useQueueStore: queue } = await import('../src/renderer/src/stores/queueStore')
const { EditorControls } = await import('../src/renderer/src/components/EditorControls')

const BAYER: SourceCapabilities = {
  foveon: false,
  whiteBalance: true,
  renderedOnly: true,
  bayer: true
}
const COLOR: SourceCapabilities = { foveon: false, whiteBalance: true, renderedOnly: true }
const MONO: SourceCapabilities = { foveon: false, whiteBalance: false, renderedOnly: true }
const FOVEON: SourceCapabilities = { foveon: true, whiteBalance: true, renderedOnly: false }
const PATH = '/photos/b.DNG'

/** A Bayer DNG recipe with a white balance and a demosaic. Undefined keeps a legacy recipe. */
const bayerRecipe = (dngDemosaic?: EditRecipe['dngDemosaic']): EditRecipe => {
  const recipe = sourceDefaultRecipe(BAYER)
  delete recipe.dngDemosaic
  return {
    ...recipe,
    temperature: 5000,
    tint: 8,
    whiteBalanceGains: [1.5, 1, 0.8],
    ...(dngDemosaic !== undefined && { dngDemosaic })
  }
}

function open(recipe: EditRecipe, capabilities = BAYER): void {
  editor.setState({
    session: { sessionId: 'b', path: PATH, recipe, revision: 0, capabilities, sourceKind: 'dng' },
    documents: { [PATH]: { recipe, revision: 0, past: [], future: [], dirty: false } },
    preview: { sessionId: 'b', revision: 0, url: 'preview', width: 3, height: 2 },
    loading: false,
    closing: false,
    before: false
  })
}
const current = (): EditRecipe => editor.getState().documents[PATH].recipe

describe('DNG demosaic recipes', () => {
  it('starts only a new Bayer or monochrome DNG with Default', () => {
    expect(sourceDefaultRecipe(BAYER).dngDemosaic).toBe('default')
    expect(sourceDefaultRecipe(MONO).dngDemosaic).toBe('default')
    expect(sourceDefaultRecipe(COLOR)).not.toHaveProperty('dngDemosaic')
    expect(sourceDefaultRecipe(FOVEON)).not.toHaveProperty('dngDemosaic')
    expect(defaultRecipe()).not.toHaveProperty('dngDemosaic')
    // Without the backend field, a DNG is not a Bayer DNG.
    expect(capabilitiesOf({ path: '/a/legacy.dng' }).bayer).toBeFalsy()
  })

  it('keeps a legacy Bayer recipe legacy and strips the demosaic of other sources', () => {
    expect(supportedRecipe(bayerRecipe(), BAYER)).not.toHaveProperty('dngDemosaic')
    expect(supportedRecipe(bayerRecipe(null), BAYER)).not.toHaveProperty('dngDemosaic')
    expect(supportedRecipe(bayerRecipe('dcb'), BAYER).dngDemosaic).toBe('dcb')
    for (const capabilities of [COLOR, FOVEON]) {
      const recipe = supportedRecipe(bayerRecipe('mono'), capabilities)
      expect(recipe).not.toHaveProperty('dngDemosaic')
      // Mono means nothing to these sources, so their white balance stays.
      expect(recipe).toMatchObject({ temperature: 5000, tint: 8 })
    }
  })

  it('keeps Default and Mono on a monochrome DNG and strips other methods', () => {
    for (const method of ['default', 'mono'] as const) {
      const recipe = supportedRecipe(bayerRecipe(method), MONO)
      expect(recipe).toMatchObject({ dngDemosaic: method, temperature: null, tint: 0 })
      expect(monoDemosaic(MONO, recipe)).toBe(true)
      expect(hasWhiteBalance(MONO, recipe)).toBe(false)
    }
    expect(supportedRecipe(bayerRecipe('amaze'), MONO)).not.toHaveProperty('dngDemosaic')
    // A legacy monochrome recipe is not a Mono demosaic, and Default on Bayer keeps color.
    expect(monoDemosaic(MONO, bayerRecipe())).toBe(false)
    expect(monoDemosaic(BAYER, bayerRecipe('default'))).toBe(false)
    expect(hasWhiteBalance(BAYER, bayerRecipe('default'))).toBe(true)
    expect(monoDemosaic(COLOR, bayerRecipe('mono'))).toBe(false)
    expect(demosaicsOf(COLOR)).toEqual([])
    expect(demosaicsOf(FOVEON)).toEqual([])
  })

  it('removes the white balance of a Mono demosaic', () => {
    expect(supportedRecipe(bayerRecipe('mono'), BAYER)).toMatchObject({
      dngDemosaic: 'mono',
      temperature: null,
      tint: 0,
      whiteBalanceGains: null
    })
  })

  it('keeps the target demosaic when a look pastes', () => {
    const look = { ...bayerRecipe('mono'), contrast: 30 }
    // A legacy target stays legacy, and a Mono source has no white balance to give.
    const legacy = pasteRecipe(look, bayerRecipe(), BAYER, BAYER)
    expect(legacy).not.toHaveProperty('dngDemosaic')
    expect(legacy).toMatchObject({ contrast: 30, temperature: 5000, tint: 8 })
    expect(pasteRecipe(bayerRecipe('amaze'), bayerRecipe('igv'), BAYER, BAYER).dngDemosaic).toBe(
      'igv'
    )
    // A Mono target keeps Mono, without white balance.
    expect(pasteRecipe(bayerRecipe('dcb'), bayerRecipe('mono'), BAYER, BAYER)).toMatchObject({
      dngDemosaic: 'mono',
      temperature: null
    })
    // Other sources do not take the field, even when an invalid target has it.
    expect(pasteRecipe(look, sourceDefaultRecipe(COLOR), BAYER, COLOR)).not.toHaveProperty(
      'dngDemosaic'
    )
    const x3f = { ...defaultRecipe(), dngDemosaic: 'dcb' as const }
    expect(pasteRecipe(look, x3f, BAYER, FOVEON)).not.toHaveProperty('dngDemosaic')
    // A monochrome target keeps its method, and a Bayer source does not give one.
    const mono = sourceDefaultRecipe(MONO)
    expect(pasteRecipe(bayerRecipe('dcb'), mono, BAYER, MONO).dngDemosaic).toBe('default')
    expect(pasteRecipe(mono, bayerRecipe('igv'), MONO, BAYER).dngDemosaic).toBe('igv')
  })

  it('copies, pastes, and resets the Demosaic section', () => {
    const section = EDITOR_SECTIONS.demosaic
    const target = bayerRecipe('lmmse')
    expect(pasteSection(section, 'demosaic', bayerRecipe('vng4'), target, BAYER, BAYER)).toEqual({
      dngDemosaic: 'vng4'
    })
    // A legacy recipe has no method to give.
    expect(pasteSection(section, 'demosaic', bayerRecipe(), target, BAYER, BAYER)).toEqual({})
    expect(resetSection(section, bayerRecipe('mono'), target)).toEqual({ dngDemosaic: 'default' })
    // A monochrome DNG takes Default and Mono only.
    const mono = sourceDefaultRecipe(MONO)
    expect(pasteSection(section, 'demosaic', bayerRecipe('dcb'), mono, BAYER, MONO)).toEqual({})
    expect(pasteSection(section, 'demosaic', bayerRecipe('mono'), mono, BAYER, MONO)).toEqual({
      dngDemosaic: 'mono'
    })
    expect(pasteSection(section, 'demosaic', mono, target, MONO, BAYER)).toEqual({
      dngDemosaic: 'default'
    })
    // A Mono source has no white balance for the White balance section.
    expect(
      pasteSection(
        EDITOR_SECTIONS.whiteBalance,
        'whiteBalance',
        bayerRecipe('mono'),
        target,
        BAYER,
        BAYER
      )
    ).toEqual({})
  })

  it('keeps the demosaic in the as-shot recipe of Before and Reset', () => {
    const session = {
      sessionId: 'b',
      path: PATH,
      recipe: bayerRecipe(),
      revision: 0,
      capabilities: BAYER
    }
    expect(asShotRecipe(session, { seed: 1, dngDemosaic: 'hphd' }).dngDemosaic).toBe('hphd')
    expect(asShotRecipe(session, { seed: 1 })).not.toHaveProperty('dngDemosaic')
    expect(
      asShotRecipe({ ...session, capabilities: COLOR }, { seed: 1, dngDemosaic: 'hphd' })
    ).not.toHaveProperty('dngDemosaic')
  })
})

describe('DNG demosaic editing', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(null)
    queue.setState({ isProcessing: false, isPreparing: false, files: [] })
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
    editor.setState({ session: null, documents: {}, preview: null })
  })

  it('changes to Mono and back in one undoable edit each', () => {
    open(bayerRecipe('amaze'))
    editor.getState().change({ dngDemosaic: 'mono' })
    expect(current()).toMatchObject({
      dngDemosaic: 'mono',
      temperature: null,
      tint: 0,
      whiteBalanceGains: null
    })
    expect(editor.getState().documents[PATH]).toMatchObject({ dirty: true, revision: 1 })
    expect(editor.getState().documents[PATH].past).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith('editor:save', expect.objectContaining({ path: PATH }))
    editor.getState().undo()
    expect(current()).toMatchObject({ dngDemosaic: 'amaze', temperature: 5000, tint: 8 })
    editor.getState().redo()
    expect(current().dngDemosaic).toBe('mono')
  })

  it('keeps the demosaic on Reset and skips the white balance picker for Mono', async () => {
    open({
      ...bayerRecipe('mono'),
      temperature: null,
      tint: 0,
      whiteBalanceGains: null,
      contrast: 20
    })
    editor.getState().reset()
    expect(current()).toMatchObject({ dngDemosaic: 'mono', contrast: 0 })
    await editor.getState().pickWhiteBalance(0.5, 0.5)
    expect(invoke).not.toHaveBeenCalledWith('editor:pickWhiteBalance', expect.anything())
  })
})

describe('DNG demosaic controls', () => {
  const change = vi.fn()
  const original = editor.getState().change
  function show(recipe: EditRecipe, capabilities = BAYER): void {
    open(recipe, capabilities)
    editor.setState({ change })
    render(
      <EditorControls recipe={recipe} picking={false} setPicking={() => {}} onNavigate={() => {}} />
    )
  }
  const select = (): HTMLElement => screen.getByRole('button', { name: t('editor.demosaicMethod') })
  /** Opens the demosaic menu, which picks `choice`, and returns its item labels. */
  async function choose(
    choice: string | null
  ): Promise<Array<{ label: string; disabled?: boolean }>> {
    invoke.mockImplementation(async (channel) => (channel === 'menu:popup' ? choice : null))
    await act(async () => fireEvent.click(select()))
    const call = invoke.mock.calls.find(([channel]) => channel === 'menu:popup')!
    return (call[1] as { items: Array<{ label: string; disabled?: boolean }> }).items
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
    change.mockReset()
    invoke.mockReset().mockResolvedValue(null)
    queue.setState({ isProcessing: false, isPreparing: false })
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
    editor.setState({ change: original, session: null, documents: {}, preview: null })
    vi.unstubAllGlobals()
  })

  it('offers Default and the ten methods and selects one in one change', async () => {
    show(bayerRecipe('amaze'))
    expect(select().textContent).toBe('AMaZE')
    const items = await choose('mono')
    expect(items.map((item) => item.label)).toEqual([
      t('editor.demosaicDefault'),
      'AMaZE',
      'DCB',
      'AHD',
      'EAHD',
      'HPHD',
      'IGV',
      'LMMSE',
      'VNG4',
      t('editor.demosaicMono'),
      t('editor.demosaicFast')
    ])
    expect(change.mock.calls).toEqual([[{ dngDemosaic: 'mono' }]])
  })

  it('shows a collapsed section after Detail with a visible Algorithm label', () => {
    show(bayerRecipe('default'))
    expect(select().textContent).toBe(t('editor.demosaicDefault'))
    expect(select().querySelector('[data-caption]')?.getAttribute('data-caption')).toBe(
      t('editor.demosaicMethod')
    )
    const details = select().closest('details')!
    expect(details.open).toBe(false)
    expect(details.previousElementSibling?.querySelector('summary')?.textContent).toBe(
      t('editor.detail')
    )
    // A toggle is stored, as in the other sections.
    act(() => {
      details.open = true
      fireEvent(details, new Event('toggle'))
    })
    cleanup()
    show(bayerRecipe('default'))
    expect(select().closest('details')!.open).toBe(true)
  })

  it('offers Default and Mono on a monochrome DNG with gray controls for both', async () => {
    show(sourceDefaultRecipe(MONO), MONO)
    expect(select().textContent).toBe(t('editor.demosaicDefault'))
    const items = await choose('mono')
    expect(items.map((item) => item.label)).toEqual([
      t('editor.demosaicDefault'),
      t('editor.demosaicMono')
    ])
    expect(change.mock.calls).toEqual([[{ dngDemosaic: 'mono' }]])
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tabGrading') }))
    expect(screen.queryByText(t('editor.whiteBalance'))).toBeNull()
    expect(screen.getByRole('slider', { name: t('editor.warmth') })).toBeTruthy()
    expect(screen.getByText(t('editor.toneMixer'))).toBeTruthy()
    expect(screen.queryByRole('slider', { name: t('editor.saturation') })).toBeNull()
  })

  it('shows Legacy only for a recipe without a method', async () => {
    show(bayerRecipe())
    expect(select().textContent).toBe(t('editor.demosaicLegacy'))
    const items = await choose('legacy')
    expect(items.at(-1)).toMatchObject({ label: t('editor.demosaicLegacy'), disabled: true })
    expect(change).not.toHaveBeenCalled()
  })

  it('resets the section to Default with Option-click', () => {
    show(bayerRecipe('dcb'))
    fireEvent.click(screen.getByText(t('editor.demosaic')), { altKey: true })
    expect(change).toHaveBeenCalledWith({ dngDemosaic: 'default' })
  })

  it('has no demosaic for a DNG without a Bayer pattern', () => {
    show(sourceDefaultRecipe(COLOR), COLOR)
    expect(screen.queryByText(t('editor.demosaic'))).toBeNull()
  })

  it('shows gray controls without white balance for Mono', () => {
    show(supportedRecipe(bayerRecipe('mono'), BAYER))
    expect(screen.getByText(t('editor.demosaicMonoHelp'))).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tabGrading') }))
    expect(screen.queryByText(t('editor.whiteBalance'))).toBeNull()
    expect(screen.getByRole('slider', { name: t('editor.warmth') })).toBeTruthy()
    expect(screen.getByText(t('editor.toneMixer'))).toBeTruthy()
    expect(screen.queryByRole('slider', { name: t('editor.saturation') })).toBeNull()
    expect(screen.queryByText(t('editor.colorMixer'))).toBeNull()
    // Monochrome filters mix Foveon layers, so a DNG without black-and-white film has none.
    expect(screen.queryByText(t('editor.filter'))).toBeNull()
  })

  it('keeps the color controls of a legacy monochrome DNG recipe', async () => {
    const legacy = sourceDefaultRecipe(MONO)
    delete legacy.dngDemosaic
    show(legacy, MONO)
    expect(select().textContent).toBe(t('editor.demosaicLegacy'))
    expect((await choose(null)).map((item) => item.label)).toEqual([
      t('editor.demosaicDefault'),
      t('editor.demosaicMono'),
      t('editor.demosaicLegacy')
    ])
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tabGrading') }))
    expect(screen.queryByText(t('editor.whiteBalance'))).toBeNull()
    expect(screen.getByRole('slider', { name: t('editor.saturation') })).toBeTruthy()
    expect(screen.queryByRole('slider', { name: t('editor.warmth') })).toBeNull()
  })

  it('keeps the color controls and white balance for AMaZE', () => {
    show(bayerRecipe('amaze'))
    expect(screen.queryByText(t('editor.demosaicMonoHelp'))).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: t('editor.tabGrading') }))
    expect(screen.getByText(t('editor.whiteBalance'))).toBeTruthy()
    expect(screen.getByRole('slider', { name: t('editor.saturation') })).toBeTruthy()
  })
})
