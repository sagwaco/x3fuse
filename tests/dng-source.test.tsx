// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  AEROCHROME_MATRIX,
  DEFAULT_FILM,
  capabilitiesOf,
  defaultRecipe,
  pasteRecipe,
  sourceDefaultRecipe,
  supportedRecipe,
  type EditRecipe,
  type EditorSession,
  type SourceCapabilities
} from '@shared/editor'
import { EDITOR_SECTIONS, pasteSection } from '@shared/editorSections'
import { defaultDenoiseOptions } from '@shared/denoise'
import { batchSettings, DEFAULT_SETTINGS, RAW_PATH, type X3FFileDTO } from '@shared/types'
import { t } from '../src/renderer/src/lib/strings'

const invoke = vi.fn(async (_channel?: unknown, _payload?: unknown): Promise<unknown> => undefined)
;(window as unknown as { x3f: unknown }).x3f = { invoke, on: () => () => {} }
const { useQueueStore: queue, exportSettings } =
  await import('../src/renderer/src/stores/queueStore')
const { useEditorStore: editor, asShotRecipe } =
  await import('../src/renderer/src/stores/editorStore')
const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
const { useNavStore } = await import('../src/renderer/src/stores/navStore')
const { outputFileName } = await import('../src/renderer/src/lib/outputName')
const { LookPicker } = await import('../src/renderer/src/components/LookPicker')
const { EditorControls, EmulsionControls } =
  await import('../src/renderer/src/components/EditorControls')

const COLOR: SourceCapabilities = { foveon: false, whiteBalance: true, renderedOnly: true }
const MONO: SourceCapabilities = { foveon: false, whiteBalance: false, renderedOnly: true }
const FOVEON: SourceCapabilities = { foveon: true, whiteBalance: true, renderedOnly: false }

const x3f: X3FFileDTO = { id: 'x', path: '/photos/x.X3F', fileName: 'x.X3F' }
const dng: X3FFileDTO = {
  id: 'd',
  path: '/photos/d.DNG',
  fileName: 'd.DNG',
  sourceKind: 'dng',
  capabilities: COLOR
}

/** A full spectrum X3F recipe with a Sigma profile, Foveon denoise, and Fill Light. */
const foveonRecipe = (): EditRecipe => ({
  ...defaultRecipe(),
  cameraProfile: 'Vivid',
  fillLight: 1.2,
  denoise: 7,
  monochrome: { filter: 'red' },
  temperature: 4200,
  tint: 12,
  whiteBalanceGains: [1.8, 1, 0.6],
  film: null,
  exposure: 0.5
})

describe('DNG sources', () => {
  it('detects the source from the backend fields, else from the path', () => {
    expect(capabilitiesOf(dng)).toBe(COLOR)
    expect(capabilitiesOf({ path: '/a/legacy.dng' })).toEqual(COLOR)
    expect(capabilitiesOf({ path: '/a/b.X3F' })).toEqual(FOVEON)
    expect(capabilitiesOf({ path: '/a/b.X3I' })).toEqual(FOVEON)
    expect(['a.X3F', 'b.x3i', 'c.DNG', 'd.dng'].every((path) => RAW_PATH.test(path))).toBe(true)
    expect(RAW_PATH.test('e.jpg')).toBe(false)
    // JPEG and TIFF names keep the .DNG extension, as they keep .X3F.
    const rendered = { ...batchSettings(DEFAULT_SETTINGS), rendering: 'rendered' as const }
    expect(outputFileName(dng, { ...rendered, outputFormat: 'jpeg' })).toBe('d.DNG.jpg')
    expect(outputFileName(dng, { ...rendered, outputFormat: 'tiff' })).toBe('d.DNG.tif')
  })

  it('starts a DNG with the neutral digital look and removes Foveon settings', () => {
    expect(sourceDefaultRecipe(COLOR)).toEqual({
      ...defaultRecipe(),
      cameraProfile: null,
      film: null,
      rawColor: null,
      monochrome: null,
      denoise: 0,
      denoiseOptions: defaultDenoiseOptions(),
      fillLight: 0
    })
    expect(sourceDefaultRecipe(FOVEON)).toEqual(defaultRecipe())
    const recipe = {
      ...foveonRecipe(),
      rawColor: { gains: [2, 1, 0.5], matrix: AEROCHROME_MATRIX }
    }
    expect(supportedRecipe(recipe, FOVEON)).toBe(recipe)
    expect(supportedRecipe(recipe, COLOR)).toMatchObject({
      cameraProfile: null,
      rawColor: null,
      monochrome: null,
      fillLight: 0,
      denoise: 0,
      temperature: 4200,
      exposure: 0.5
    })
    // A monochrome DNG has no white balance.
    expect(supportedRecipe(recipe, MONO)).toMatchObject({
      temperature: null,
      tint: 0,
      whiteBalanceGains: null
    })
    // A black-and-white film keeps its taking filter.
    const trix = { ...defaultRecipe(), film: { ...defaultRecipe().film!, film: 21 } }
    const bw = { ...trix, monochrome: { filter: 'yellow' as const } }
    expect(supportedRecipe(bw, COLOR).monochrome).toEqual({ filter: 'yellow' })
    expect(supportedRecipe({ ...bw, film: null }, COLOR).monochrome).toBeNull()
  })

  it('keeps the target white balance and Foveon settings when a paste crosses sensors', () => {
    const fullSpectrum = {
      ...defaultRecipe(),
      film: null,
      rawColor: { gains: [3, 1, 0.4] as [number, number, number], matrix: AEROCHROME_MATRIX },
      temperature: 3000,
      contrast: 40
    }
    const target = { ...sourceDefaultRecipe(COLOR), temperature: 5600, tint: 4, seed: 9 }
    const pasted = pasteRecipe(fullSpectrum, target, FOVEON, COLOR)
    expect(pasted).toMatchObject({
      rawColor: null,
      temperature: 5600,
      tint: 4,
      contrast: 40,
      seed: 9
    })
    // Layer gains of an X3F do not go to a DNG.
    const gains = pasteRecipe(foveonRecipe(), target, FOVEON, COLOR)
    expect(gains).toMatchObject({ temperature: 5600, tint: 4, whiteBalanceGains: null })
    expect(gains).toMatchObject({ cameraProfile: null, fillLight: 0, denoise: 0, exposure: 0.5 })
    // Temperature and tint are calibrated, so they cross sensors.
    const kelvin = { ...foveonRecipe(), whiteBalanceGains: null }
    expect(pasteRecipe(kelvin, target, FOVEON, COLOR)).toMatchObject({
      temperature: 4200,
      tint: 12
    })
    // A DNG does not turn off the Foveon settings of an X3F.
    const x3fTarget = foveonRecipe()
    const fromDng = pasteRecipe(
      { ...sourceDefaultRecipe(COLOR), exposure: -1 },
      x3fTarget,
      COLOR,
      FOVEON
    )
    expect(fromDng).toMatchObject({
      exposure: -1,
      cameraProfile: 'Vivid',
      fillLight: 1.2,
      denoise: 7,
      monochrome: { filter: 'red' },
      whiteBalanceGains: null
    })
    // A monochrome DNG has no white balance to give.
    expect(pasteRecipe(sourceDefaultRecipe(MONO), x3fTarget, MONO, FOVEON)).toMatchObject({
      temperature: 4200,
      whiteBalanceGains: [1.8, 1, 0.6]
    })
    // Between X3F files, a paste is unchanged.
    expect(pasteRecipe(fullSpectrum, defaultRecipe())).toMatchObject({
      rawColor: fullSpectrum.rawColor,
      temperature: 3000
    })
  })

  it('pastes sections without crossing sensor gains or Foveon settings', () => {
    const wb = EDITOR_SECTIONS.whiteBalance
    const target = sourceDefaultRecipe(COLOR)
    expect(pasteSection(wb, 'whiteBalance', foveonRecipe(), target, FOVEON, COLOR)).toEqual({})
    expect(
      pasteSection(wb, 'whiteBalance', foveonRecipe(), defaultRecipe(), FOVEON, FOVEON)
    ).toEqual({ temperature: 4200, tint: 12, whiteBalanceGains: [1.8, 1, 0.6] })
    const detail = { ...target, sharpen: 30 }
    expect(
      pasteSection(EDITOR_SECTIONS.detail, 'detail', detail, foveonRecipe(), COLOR, FOVEON)
    ).toEqual({ sharpen: 30, texture: 0, clarity: 0 })
    expect(
      pasteSection(
        EDITOR_SECTIONS.light,
        'light',
        { ...target, whites: 5 },
        foveonRecipe(),
        COLOR,
        FOVEON
      )
    ).not.toHaveProperty('fillLight')
  })

  it('resets a DNG to its neutral look and never stores Foveon settings', () => {
    const session: EditorSession = {
      sessionId: 's',
      path: dng.path,
      recipe: sourceDefaultRecipe(COLOR),
      revision: 0,
      asShotCameraProfile: null,
      capabilities: COLOR,
      sourceKind: 'dng'
    }
    expect(asShotRecipe(session, { seed: 3 })).toEqual({ ...sourceDefaultRecipe(COLOR), seed: 3 })
    invoke
      .mockReset()
      .mockImplementation(async (channel, payload) =>
        channel === 'editor:save'
          ? { recipe: (payload as { recipe: EditRecipe }).recipe, revision: 1 }
          : undefined
      )
    editor.setState({
      session,
      documents: {
        [dng.path]: { recipe: session.recipe, revision: 0, past: [], future: [], dirty: false }
      },
      loading: false,
      closing: false,
      before: false
    })
    editor.getState().change({ cameraProfile: 'Vivid', fillLight: 1, denoise: 5, exposure: 1 })
    const recipe = editor.getState().documents[dng.path].recipe
    expect(recipe).toMatchObject({ cameraProfile: null, fillLight: 0, denoise: 0, exposure: 1 })
    editor.setState({ session: null, documents: {} })
  })
})

describe('DNG exports', () => {
  beforeEach(() => {
    invoke
      .mockReset()
      .mockImplementation(async (channel?: unknown) =>
        channel === 'queue:existingOutputs'
          ? []
          : channel === 'editor:preview'
            ? { url: 'preview', sourceRevision: 'r' }
            : channel === 'dialog:pickOutputDir'
              ? '/out'
              : undefined
      )
    queue.setState({
      files: [x3f, dng],
      selectedIds: new Set(['x', 'd']),
      activeId: 'x',
      draft: null,
      batch: null,
      error: null,
      isProcessing: false,
      isPreparing: false,
      isCancelling: false,
      pendingReconversion: null
    })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
    useNavStore.setState({ screen: 'queue' })
  })
  const settle = (): Promise<void> =>
    vi.waitFor(() => expect(queue.getState().isPreparing).toBe(false))
  const started = (): unknown[] =>
    invoke.mock.calls.filter(([channel]) => channel === 'convert:start')

  it('exports a mixed selection as rendered images, and the X3F subset as originals', async () => {
    queue.getState().openExport()
    await settle()
    let draft = queue.getState().draft!
    expect(draft.settings).toMatchObject({ rendering: 'rendered', outputFormat: 'jpeg' })
    // A mixed selection keeps rendered images, also when it asks for an original DNG.
    queue.getState().updateDraft({ rendering: 'original', outputFormat: 'dng' })
    draft = queue.getState().draft!
    expect(exportSettings(draft, 'd')).toMatchObject({
      rendering: 'rendered',
      outputFormat: 'jpeg'
    })
    expect(exportSettings(draft, 'x')).toMatchObject({
      rendering: 'rendered',
      outputFormat: 'jpeg'
    })
    queue.getState().updateDraft({ outputFormat: 'tiff' })
    expect(exportSettings(queue.getState().draft!, 'd').outputFormat).toBe('tiff')
    // The X3F alone can still export its original.
    queue.getState().setSelection(new Set(['x']), 'x')
    queue.getState().updateDraft({ rendering: 'original', outputFormat: 'dng' })
    draft = queue.getState().draft!
    expect(exportSettings(draft, 'x')).toMatchObject({ rendering: 'original', outputFormat: 'dng' })
    expect(exportSettings(draft, 'd')).toMatchObject({
      rendering: 'rendered',
      outputFormat: 'tiff'
    })
    // Overwriting the mixed selection with the X3F settings keeps the DNG rendered.
    queue.getState().setSelection(new Set(['x', 'd']), 'x')
    queue.getState().resolveDraftSettings(true)
    draft = queue.getState().draft!
    expect(exportSettings(draft, 'd').rendering).toBe('rendered')
    expect(['jpeg', 'tiff']).toContain(exportSettings(draft, 'd').outputFormat)
  })

  it('refuses an original DNG export of a DNG from per-file settings', async () => {
    queue.getState().openExport()
    await settle()
    const draft = queue.getState().draft!
    const original = {
      ...draft.settings,
      rendering: 'original' as const,
      outputFormat: 'dng' as const
    }
    queue.setState({
      draft: { ...draft, fileSettings: { d: original, x: original } },
      isPreparing: false
    })
    await queue.getState().commitExport()
    expect(queue.getState().error).toBe(t('export.dng_rendered_only'))
    expect(started()).toHaveLength(0)
  })

  it('opens the Export screen for original presets and previous settings of a DNG', async () => {
    await queue.getState().exportPreset('dng')
    expect(useNavStore.getState().screen).toBe('export')
    expect(invoke).not.toHaveBeenCalledWith('dialog:pickOutputDir')
    expect(queue.getState().draft!.settings.rendering).toBe('rendered')
    queue.setState({ draft: null, isPreparing: false })
    useNavStore.setState({ screen: 'queue' })

    await queue.getState().exportPreset('embeddedJpg', new Set(['d']))
    expect(useNavStore.getState().screen).toBe('export')
    queue.setState({ draft: null, isPreparing: false })
    useNavStore.setState({ screen: 'queue' })

    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, hasPreviousConversion: true, outputFormat: 'embeddedJpg' }
    })
    await queue.getState().convertPrevious(new Set(['d']))
    expect(useNavStore.getState().screen).toBe('export')
    expect(started()).toHaveLength(0)
    queue.setState({ draft: null, isPreparing: false })
    useNavStore.setState({ screen: 'queue' })

    // Previous JPEG settings always render, so they export a DNG at once.
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        hasPreviousConversion: true,
        rendering: 'original',
        outputFormat: 'jpeg'
      }
    })
    await queue.getState().convertPrevious(new Set(['d']))
    expect(useNavStore.getState().screen).toBe('queue')
    expect(started()).toHaveLength(1)
    expect(started()[0]).toMatchObject([
      'convert:start',
      { settings: { rendering: 'rendered', outputFormat: 'jpeg' } }
    ])
    queue.setState({ draft: null, isPreparing: false, isProcessing: false, batch: null })
    invoke.mockClear()

    // Previous rendered settings export a DNG at once.
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        hasPreviousConversion: true,
        rendering: 'rendered',
        outputFormat: 'tiff'
      }
    })
    await queue.getState().convertPrevious(new Set(['d']))
    expect(started()).toHaveLength(1)
    expect(started()[0]).toMatchObject([
      'convert:start',
      { settings: { rendering: 'rendered', outputFormat: 'tiff' } }
    ])
  })

  it('exports X3F originals with an X3F preset', async () => {
    await queue.getState().exportPreset('dng', new Set(['x']))
    expect(started()).toHaveLength(1)
    expect(started()[0]).toMatchObject([
      'convert:start',
      { settings: { rendering: 'original', outputFormat: 'dng' } }
    ])
  })
})

describe('DNG editor controls', () => {
  const change = vi.fn()
  const original = editor.getState().change
  function Controls({ initial }: { initial: EditRecipe }): React.JSX.Element {
    const [recipe] = useState(initial)
    return (
      <>
        <EmulsionControls recipe={recipe} />
        <EditorControls
          recipe={recipe}
          picking={false}
          setPicking={() => {}}
          onNavigate={() => {}}
        />
      </>
    )
  }
  function open(capabilities: SourceCapabilities): void {
    const recipe = sourceDefaultRecipe(capabilities)
    editor.setState({
      session: { sessionId: 'c', path: dng.path, recipe, revision: 0, capabilities },
      preview: { sessionId: 'c', revision: 0, url: 'preview', width: 3, height: 2 },
      loading: false,
      closing: false,
      before: false,
      change
    })
    render(<Controls initial={recipe} />)
  }
  const tab = (name: string): void => {
    fireEvent.click(screen.getByRole('tab', { name: t(name) }))
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
    editor.setState({ change: original, session: null, preview: null })
    vi.unstubAllGlobals()
  })

  it('hides Fill Light, sensor denoise, and the white balance of a monochrome DNG', () => {
    open(MONO)
    expect(screen.queryByRole('slider', { name: t('editor.fillLight') })).toBeNull()
    expect(screen.queryByRole('slider', { name: t('editor.denoise') })).toBeNull()
    expect(screen.getByRole('slider', { name: t('editor.sharpen') })).toBeTruthy()
    tab('editor.tabGrading')
    expect(screen.queryByText(t('editor.whiteBalance'))).toBeNull()
    expect(screen.queryByText(t('editor.rawChannels'))).toBeNull()
    expect(screen.queryByText(t('editor.filter'))).toBeNull()
  })

  it('keeps the white balance of a color DNG', () => {
    open(COLOR)
    tab('editor.tabGrading')
    expect(screen.getByText(t('editor.whiteBalance'))).toBeTruthy()
  })

  it('offers the neutral digital look and film stocks, without Sigma or full spectrum looks', async () => {
    open(COLOR)
    // The gallery opens on the group of the neutral look.
    expect(screen.getByRole('button', { name: t('editor.filmGroups') }).textContent).toBe(
      t('editor.digital')
    )
    const neutral = screen.getByRole('button', { name: t('editor.neutral') })
    expect(neutral.ariaPressed).toBe('true')
    expect(screen.queryByRole('button', { name: t('editor.standard') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('editor.monochrome') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('editor.cir') })).toBeNull()
    await act(async () => fireEvent.click(neutral))
    expect(change).toHaveBeenLastCalledWith({
      film: null,
      monochrome: null,
      cameraProfile: null,
      rawColor: null
    })
  })

  it('returns from a film stock to the neutral look with a null camera profile', async () => {
    editor.setState({ change: original })
    const capabilities = COLOR
    const recipe = { ...sourceDefaultRecipe(capabilities), film: structuredClone(DEFAULT_FILM) }
    invoke
      .mockReset()
      .mockImplementation(async (channel, payload) =>
        channel === 'menu:popup'
          ? 'digital'
          : channel === 'editor:save'
            ? { recipe: (payload as { recipe: EditRecipe }).recipe, revision: 1 }
            : null
      )
    editor.setState({
      session: { sessionId: 'c', path: dng.path, recipe, revision: 0, capabilities },
      documents: { [dng.path]: { recipe, revision: 0, past: [], future: [], dirty: false } },
      preview: { sessionId: 'c', revision: 0, url: 'preview', width: 3, height: 2 },
      loading: false,
      closing: false,
      before: false
    })
    function Live(): React.JSX.Element {
      const current = editor((state) => state.documents[dng.path].recipe)
      return (
        <>
          <LookPicker kind="film" recipe={current} />
          <LookPicker kind="film" recipe={current} gallery />
        </>
      )
    }
    render(<Live />)
    // A film look opens on its film group; the Digital group has the neutral look.
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: t('editor.filmGroups') }))
    )
    const neutral = await waitFor(() => screen.getByRole('button', { name: t('editor.neutral') }))
    expect(neutral.ariaPressed).toBe('false')
    await act(async () => fireEvent.click(neutral))
    const saved = editor.getState().documents[dng.path].recipe
    expect(saved).toMatchObject({
      film: null,
      cameraProfile: null,
      rawColor: null,
      monochrome: null
    })
    expect(screen.getByRole('button', { name: t('editor.neutral') }).ariaPressed).toBe('true')
    // The compact picker names the look without a camera profile.
    expect(
      screen.getByText(t('editor.neutral'), { selector: '[data-sidebar-page] *' })
    ).toBeTruthy()
    cleanup()
    editor.setState({ documents: {} })
  })
})
