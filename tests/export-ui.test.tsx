// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_SETTINGS, shouldShowDngHighlightRecoveryOption } from '@shared/types'
import { defaultRecipe } from '@shared/editor'
import { ExportScreen } from '../src/renderer/src/components/ExportScreen'
import { exportSettings, useQueueStore } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { t } from '../src/renderer/src/lib/strings'
import i18n from '../src/renderer/src/i18n/config'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.scrollTo = vi.fn()
  HTMLElement.prototype.hasPointerCapture = () => false
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal('PointerEvent', MouseEvent)
  const files = ['a', 'b', 'excluded'].map((id) => ({
    id,
    path: `/photos/${id}.X3F`,
    fileName: `${id}.X3F`
  }))
  useQueueStore.setState({
    files,
    selectedIds: new Set(['a', 'b']),
    activeId: 'a',
    draft: null,
    isProcessing: false,
    isPreparing: false,
    error: null
  })
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, queueViewMode: 'list' },
    loaded: true
  })
  invoke.mockImplementation(async (channel, patch) => {
    if (channel === 'settings:set') return { ...useSettingsStore.getState().settings, ...patch }
  })
  useQueueStore.getState().openExport()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('switches between the shared views while keeping the export targets fixed', async () => {
  const view = render(<ExportScreen />)
  expect(screen.getByText('2 images')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Name' })).toBeTruthy()
  expect(screen.getByText('a.X3F')).toBeTruthy()
  expect(screen.getAllByText('Export format')).toHaveLength(2)
  expect(screen.getAllByText('DNG')).toHaveLength(2)
  expect(screen.queryByText(/→/)).toBeNull()
  expect(screen.queryByRole('button', { name: t('view.survey') })).toBeNull()
  expect(screen.queryByRole('group', { name: t('preview.zoom_controls') })).toBeNull()
  expect(view.container.querySelector('.window-toolbar')!.textContent).not.toContain('2 images')
  expect(screen.queryByText(t('export.images_heading'))).toBeNull()
  expect(screen.queryByText('excluded.X3F')).toBeNull()
  const cancel = screen.getByRole('button', { name: 'Cancel' })
  const exportButton = screen.getByRole('button', { name: 'Export', exact: true })
  expect(cancel.nextElementSibling).toBe(exportButton)
  expect(cancel.querySelector('svg')).toBeNull()
  expect(exportButton.querySelector('.lucide-upload')).toBeTruthy()
  expect(exportButton.classList.contains('export-action')).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: t('view.grid') }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: t('view.grid') }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  )
  expect(screen.queryByRole('button', { name: 'Name' })).toBeNull()
  expect(screen.getByText('b.X3F')).toBeTruthy()
  expect(screen.queryByText(/→/)).toBeNull()
  expect(screen.queryByRole('group', { name: t('preview.zoom_controls') })).toBeNull()
  expect(screen.queryByText('excluded.X3F')).toBeNull()
  fireEvent.doubleClick(screen.getByText('b.X3F'))
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: t('view.filmstrip') }).getAttribute('aria-pressed')
    ).toBe('true')
  )
  expect(screen.queryByText('b.X3F')).toBeNull()
  expect(screen.getByRole('group', { name: t('preview.zoom_controls') })).toBeTruthy()
  const surface = document.activeElement as HTMLElement
  act(() => surface.blur())
  fireEvent.keyDown(document.body, { key: 'ArrowRight' })
  expect(useQueueStore.getState().activeId).toBe('b')
  fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
  expect(screen.getByText('a.X3F')).toBeTruthy()
  expect(
    view.container.querySelector('[data-filmstrip]')!.previousElementSibling!.tagName
  ).not.toBe('P')
  act(() => surface.focus())
  fireEvent.keyDown(document.activeElement!, { key: 'Delete' })
  expect(useQueueStore.getState().draft!.files.map((file) => file.id)).toEqual(['a', 'b'])
  expect(useQueueStore.getState().files).toHaveLength(3)
  expect(view.container.querySelector('[data-radix-context-menu-trigger]')).toBeNull()

  fireEvent.click(cancel)
  expect(useQueueStore.getState().draft).toBeNull()
})

it('localizes the export image count', async () => {
  const language = i18n.language
  try {
    await i18n.changeLanguage('ko')
    render(<ExportScreen />)
    expect(screen.getByText('이미지 2개')).toBeTruthy()
  } finally {
    await i18n.changeLanguage(language)
  }
})

it('shows inline help on keyboard focus and hover, without changing the setting', async () => {
  render(<ExportScreen />)
  const label = t('settings.raw_compression')
  const help = screen.getByRole('button', { name: label, exact: true })
  const toggle = screen.getByRole('switch', { name: label, exact: true })
  expect(help.nextElementSibling).toBe(toggle)
  expect(screen.queryByRole('tooltip')).toBeNull()
  const checked = toggle.getAttribute('aria-checked')
  act(() => help.focus())
  expect((await screen.findByRole('tooltip')).textContent).toContain(
    t('settings.raw_compression.warning')
  )
  expect(document.querySelector('.export-help-tooltip')).toBeTruthy()
  fireEvent.keyDown(help, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  act(() => help.blur())
  fireEvent.pointerMove(help, { pointerType: 'mouse' })
  expect((await screen.findByRole('tooltip')).textContent).toContain(
    t('settings.raw_compression.warning')
  )
  expect(toggle.getAttribute('aria-checked')).toBe(checked)
})

it('updates export settings through native menus and leaves them unchanged on dismissal', async () => {
  render(<ExportScreen />)
  const format = screen.getByRole('button', { name: t('settings.conversion_format'), exact: true })
  invoke.mockResolvedValueOnce('tiff')
  fireEvent.keyDown(format, { key: 'ArrowDown' })
  expect(invoke).toHaveBeenCalledWith(
    'menu:popup',
    expect.objectContaining({
      items: [
        { value: 'dng', label: 'DNG (default)', checked: true },
        { value: 'embeddedJpg', label: 'Embedded JPG', checked: false },
        { value: 'tiff', label: 'TIFF', checked: false }
      ]
    })
  )
  await waitFor(() => expect(useQueueStore.getState().draft!.settings.outputFormat).toBe('tiff'))
  expect(screen.queryByText(t('settings.concurrency'))).toBeNull()
  invoke.mockResolvedValueOnce(null)
  fireEvent.click(format)
  await waitFor(() => expect(format.getAttribute('aria-expanded')).toBe('false'))
  expect(useQueueStore.getState().draft!.settings.outputFormat).toBe('tiff')
})

it('offers Sigma color modes for color TIFF exports only', async () => {
  render(<ExportScreen />)
  const mode = (): HTMLElement | undefined =>
    screen
      .queryAllByRole('button', { name: t('settings.color_mode'), exact: true })
      .find((button) => button.getAttribute('aria-haspopup') === 'menu')
  // DNG always embeds every color mode.
  expect(mode()).toBeUndefined()
  act(() => useQueueStore.getState().updateDraft({ outputFormat: 'tiff' }))
  invoke.mockResolvedValueOnce('FCBlue')
  fireEvent.keyDown(mode()!, { key: 'ArrowDown' })
  expect(invoke.mock.lastCall?.[1].items[0]).toEqual({
    value: 'off',
    label: t('settings.color_mode.off'),
    checked: true
  })
  await waitFor(() => expect(useQueueStore.getState().draft!.settings.colorMode).toBe('FCBlue'))
  expect(screen.getByText('FOV Classic Blue')).toBeTruthy()
  act(() => useQueueStore.getState().updateDraft({ cineon: true }))
  expect(mode()).toBeUndefined()
  act(() => useQueueStore.getState().updateDraft({ cineon: false, colorProfile: 'none' }))
  expect(mode()).toBeUndefined()
  act(() => useQueueStore.getState().updateDraft({ colorProfile: 'sRGB' }))
  invoke.mockResolvedValueOnce('off')
  fireEvent.keyDown(mode()!, { key: 'ArrowDown' })
  await waitFor(() => expect(useQueueStore.getState().draft!.settings.colorMode).toBeNull())
})

it('edits selected images and resolves mixed settings from the focused image', async () => {
  const view = render(<ExportScreen />)
  const gallery = within(view.container.querySelector('.file-queue') as HTMLElement)
  fireEvent.click(gallery.getByText('a.X3F'))
  invoke.mockResolvedValueOnce('tiff')
  fireEvent.click(screen.getByRole('button', { name: t('settings.conversion_format') }))
  await waitFor(() =>
    expect(exportSettings(useQueueStore.getState().draft!, 'a').outputFormat).toBe('tiff')
  )
  expect(exportSettings(useQueueStore.getState().draft!, 'b').outputFormat).toBe('dng')
  expect(gallery.getByText('TIFF')).toBeTruthy()
  expect(gallery.getByText('DNG')).toBeTruthy()

  fireEvent.click(gallery.getByText('b.X3F'), { metaKey: true })
  const dialog = screen.getByRole('dialog', { name: t('export.mixed_title') })
  expect(dialog.closest('aside')).toBeTruthy()
  expect(dialog.textContent).toContain('b.X3F')
  fireEvent.click(within(dialog).getByRole('button', { name: t('button.cancel') }))
  expect(useQueueStore.getState().selectedIds).toEqual(new Set(['b']))
  expect(useQueueStore.getState().activeId).toBe('b')
  expect(exportSettings(useQueueStore.getState().draft!, 'a').outputFormat).toBe('tiff')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(within(view.container.querySelector('aside')!).getByText('b.X3F')).toBeTruthy()

  fireEvent.click(gallery.getByText('a.X3F'), { ctrlKey: true })
  expect(useQueueStore.getState().activeId).toBe('a')
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: t('button.overwrite') })
  )
  const draft = useQueueStore.getState().draft!
  expect(exportSettings(draft, 'b')).toEqual(exportSettings(draft, 'a'))
  expect(useQueueStore.getState().selectedIds).toEqual(new Set(['a', 'b']))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(gallery.getAllByText('TIFF')).toHaveLength(2)

  fireEvent.click(screen.getByRole('switch', { name: t('settings.raw_compression') }))
  expect(exportSettings(useQueueStore.getState().draft!, 'a').compress).toBe(true)
  expect(exportSettings(useQueueStore.getState().draft!, 'b').compress).toBe(true)
  act(() => useQueueStore.getState().deselectAll())
  const unchanged = useQueueStore.getState().draft
  act(() => useQueueStore.getState().updateDraft({ compress: false }))
  expect(useQueueStore.getState().draft).toBe(unchanged)
  act(() => useQueueStore.getState().selectAll())
  expect(useQueueStore.getState().selectedIds).toEqual(new Set(['a', 'b']))
})

it('treats Escape in the mixed-settings dialog as Cancel', () => {
  render(<ExportScreen />)
  act(() => {
    useQueueStore.getState().setSelection(new Set(['a']), 'a')
    useQueueStore.getState().updateDraft({ denoiseIntensity: 2 })
    useQueueStore.getState().setSelection(new Set(['a', 'b']), 'a')
  })
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(useQueueStore.getState().selectedIds).toEqual(new Set(['a']))
  expect(exportSettings(useQueueStore.getState().draft!, 'b').denoiseIntensity).toBe(10)
})

it('uses collapsible sections and shows SFD RAW only for selected X3I images', () => {
  const store = useQueueStore.getState()
  store.cancelExport()
  useQueueStore.setState({
    files: store.files.map((file) =>
      file.id === 'b' ? { ...file, path: '/photos/b.X3I', fileName: 'b.X3I', frames: 7 } : file
    )
  })
  useQueueStore.getState().openExport()
  const view = render(<ExportScreen />)
  const sections = [...view.container.querySelectorAll('aside > div details')]
  expect(sections.filter((section) => section.parentElement?.tagName === 'FIELDSET')).toHaveLength(
    4
  )
  const denoise = screen.getByText(t('editor.detail'), { selector: 'summary' }).closest('details')!
  expect(denoise.open).toBe(true)
  expect(within(denoise).getByRole('spinbutton', { name: t('editor.denoise') })).toBeTruthy()
  expect(screen.getByText('SFD RAW', { selector: 'summary' })).toBeTruthy()
  act(() => useQueueStore.getState().setSelection(new Set(['a']), 'a'))
  expect(screen.queryByText('SFD RAW', { selector: 'summary' })).toBeNull()
  act(() => useQueueStore.getState().setSelection(new Set(['b']), 'b'))
  expect(screen.getByText('SFD RAW', { selector: 'summary' })).toBeTruthy()
  act(() => useQueueStore.getState().updateDraft({ outputDirectory: '/exports' }))
  expect(screen.getByRole('button', { name: 'Browse', exact: true })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Browse...' })).toBeNull()
})

it('uses editor-style numeric controls for export denoise, including off and reset', () => {
  render(<ExportScreen />)
  const input = screen.getByRole('spinbutton', { name: t('editor.denoise') }) as HTMLInputElement
  expect(input.disabled).toBe(false)
  expect(input.value).toBe('10')
  expect(input.classList.contains('font-sans')).toBe(true)
  fireEvent.change(input, { target: { value: '3' } })
  expect(exportSettings(useQueueStore.getState().draft!, 'a').denoiseIntensity).toBe(3)
  expect(exportSettings(useQueueStore.getState().draft!, 'b').denoiseIntensity).toBe(3)
  fireEvent.change(input, { target: { value: '0' } })
  expect(screen.queryByText(t('denoise.algorithm'))).toBeNull()
  fireEvent.click(screen.getByText(t('editor.denoise'), { selector: '.slider-label > span' }), {
    shiftKey: true
  })
  expect(input.value).toBe('10')
  expect(screen.getByText(t('denoise.algorithm'))).toBeTruthy()
  expect(screen.queryByRole('spinbutton', { name: t('editor.sharpen') })).toBeNull()
})

it.each(['jpeg', 'tiff'] as const)(
  'uses saved sharpening for rendered %s without export sharpening controls',
  async (outputFormat) => {
    const store = useQueueStore.getState()
    store.cancelExport()
    const recipe = { ...defaultRecipe(), sharpen: 25 }
    const file = {
      ...store.files[0],
      edit: { recipe, revision: 4, sourceRevision: 'a'.repeat(64) }
    }
    useQueueStore.setState({ files: [file], selectedIds: new Set([file.id]), activeId: file.id })
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, rendering: 'rendered', outputFormat }
    })
    invoke.mockImplementation(async (channel) => {
      if (channel === 'editor:preview')
        return { url: 'x3f-edit://saved', sourceRevision: 'a'.repeat(64) }
      if (channel === 'queue:existingOutputs') return []
    })
    useQueueStore.getState().openExport()
    await waitFor(() => expect(useQueueStore.getState().isPreparing).toBe(false))
    render(<ExportScreen />)
    expect(screen.queryByRole('slider', { name: t('editor.sharpen') })).toBeNull()
    expect(screen.queryByRole('spinbutton', { name: t('editor.sharpen') })).toBeNull()
    expect(screen.queryByText(t('editor.detail'), { selector: 'summary' })).toBeNull()
    expect(invoke).toHaveBeenCalledWith('editor:preview', {
      path: file.path,
      recipe,
      revision: 4,
      sourceRevision: 'a'.repeat(64)
    })
    await act(() => useQueueStore.getState().commitExport())
    const request = invoke.mock.calls.find(([channel]) => channel === 'convert:start')![1]
    expect(request.files[0].recipe.sharpen).toBe(25)
    expect(request.settings).not.toHaveProperty('sharpen')
    expect(useQueueStore.getState().files[0].edit!.recipe.sharpen).toBe(25)
    expect(invoke).not.toHaveBeenCalledWith('editor:save', expect.anything())
  }
)

it.each([
  ['SIGMA DP1 Merrill', true],
  ['SIGMA DP2 Merrill', true],
  ['DP3M', true],
  ['SIGMA SD1', true],
  ['SD1 Merrill', true],
  ['SIGMA dp2 Quattro', false],
  ['SIGMA SD15', false],
  ['SIGMA DP2', false],
  [undefined, false]
])('limits highlight recovery to Merrill models: %s', (model, supported) => {
  expect(shouldShowDngHighlightRecoveryOption('dng', [model])).toBe(supported)
  expect(shouldShowDngHighlightRecoveryOption('tiff', [model])).toBe(false)
})

it('shows the union of options and explains partial applicability for Merrill and SFD Quattro', async () => {
  const draft = useQueueStore.getState().draft!
  useQueueStore.setState({
    draft: {
      ...draft,
      files: draft.files.map((file) => ({
        ...file,
        ...(file.id === 'b' ? { path: '/photos/b.X3I', fileName: 'b.X3I', frames: 7 } : {}),
        exif: [
          { label: 'Camera', value: file.id === 'a' ? 'SIGMA SD1 Merrill' : 'SIGMA dp2 Quattro' }
        ]
      }))
    }
  })
  render(<ExportScreen />)
  const toggle = (): HTMLElement | null =>
    screen.queryByRole('switch', { name: t('settings.dng_highlight_recovery') })
  const sfd = (): HTMLElement | null => screen.queryByText('SFD RAW', { selector: 'summary' })
  const warnings = (): NodeListOf<HTMLElement> =>
    document.querySelectorAll('button.text-yellow-400')
  expect(toggle()).toBeTruthy()
  expect(sfd()).toBeTruthy()
  expect(warnings()).toHaveLength(2)
  const before = useQueueStore.getState().draft
  const recoveryWarning = screen.getByRole('button', {
    name: t('settings.warning_label', { setting: t('settings.dng_highlight_recovery') })
  })
  expect(recoveryWarning.querySelector('.lucide-triangle-alert')).toBeTruthy()
  act(() => recoveryWarning.focus())
  expect((await screen.findByRole('tooltip')).textContent).toBe(
    t('export.partial_highlight_recovery')
  )
  fireEvent.click(recoveryWarning)
  expect(useQueueStore.getState().draft).toBe(before)
  fireEvent.keyDown(recoveryWarning, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  act(() => recoveryWarning.blur())
  const sfdWarning = screen.getByRole('button', {
    name: t('settings.warning_label', { setting: t('editor.x3iSource') })
  })
  expect(sfdWarning.querySelector('.lucide-triangle-alert')).toBeTruthy()
  fireEvent.pointerMove(sfdWarning, { pointerType: 'mouse' })
  expect((await screen.findByRole('tooltip')).textContent).toBe(t('export.partial_sfd_source'))
  fireEvent.pointerLeave(sfdWarning, { clientX: 10, clientY: 10 })
  fireEvent.pointerMove(document.body, { clientX: 100, clientY: 100 })
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  expect(useQueueStore.getState().draft).toBe(before)
  fireEvent.click(toggle()!)
  for (const id of ['a', 'b'])
    expect(exportSettings(useQueueStore.getState().draft!, id).dngHighlightRecovery).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => useQueueStore.getState().setSelection(new Set(['a']), 'a'))
  expect(toggle()).toBeTruthy()
  expect(sfd()).toBeNull()
  expect(warnings()).toHaveLength(0)
  act(() => useQueueStore.getState().setSelection(new Set(['b']), 'b'))
  expect(toggle()).toBeNull()
  expect(sfd()).toBeTruthy()
  expect(warnings()).toHaveLength(0)
  act(() => useQueueStore.getState().setSelection(new Set(['a', 'b']), 'b'))
  expect(toggle()).toBeTruthy()
  expect(sfd()).toBeTruthy()
  expect(warnings()).toHaveLength(2)
  expect(shouldShowDngHighlightRecoveryOption('dng', [undefined, 'SIGMA SD1'])).toBe(true)
  expect(shouldShowDngHighlightRecoveryOption('dng', [])).toBe(false)
})

it.each(['Merrill', 'X3I', 'unknown'])(
  'shows no applicability warning when all selected images are %s',
  (kind) => {
    const draft = useQueueStore.getState().draft!
    useQueueStore.setState({
      draft: {
        ...draft,
        files: draft.files.map((file) => ({
          ...file,
          ...(kind === 'X3I' ? { path: `/photos/${file.id}.X3I` } : {}),
          cameraModel: kind === 'Merrill' ? 'SIGMA SD1 Merrill' : undefined
        }))
      }
    })
    render(<ExportScreen />)
    expect(document.querySelectorAll('button.text-yellow-400')).toHaveLength(0)
    expect(
      screen.queryByRole('switch', { name: t('settings.dng_highlight_recovery') }) !== null
    ).toBe(kind === 'Merrill')
    expect(screen.queryByText('SFD RAW', { selector: 'summary' }) !== null).toBe(kind === 'X3I')
  }
)
