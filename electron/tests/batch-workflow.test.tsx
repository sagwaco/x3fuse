// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { batchSettings, DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'
import * as strings from '../src/renderer/src/lib/strings'

const invoke = vi.fn(async (): Promise<unknown> => undefined)
;(window as unknown as { x3f: unknown }).x3f = { invoke, on: () => () => {}, pathForFile: () => '' }
const { useQueueStore: store } = await import('../src/renderer/src/stores/queueStore')
const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
const { useNavStore } = await import('../src/renderer/src/stores/navStore')
const { Toolbar } = await import('../src/renderer/src/components/Toolbar')
const { BatchProgress } = await import('../src/renderer/src/components/BatchProgress')
const files: X3FFileDTO[] = ['b', 'a', 'c'].map((id) => ({
  id,
  path: `/photos/${id}.X3F`,
  fileName: `${id}.X3F`
}))
const settings = batchSettings(DEFAULT_SETTINGS)

beforeEach(() => {
  // Give the real virtualizer a viewport in jsdom, which has no layout.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500)
  invoke
    .mockReset()
    .mockImplementation(async (channel?: unknown) =>
      channel === 'queue:existingOutputs' ? [] : undefined
    )
  store.setState({
    files,
    selectedIds: new Set(['b', 'a']),
    activeId: 'a',
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
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function start(): Promise<string> {
  store.getState().openExport()
  await store.getState().commitExport()
  const id = store.getState().batch!.id
  store.getState().onBatchStarted({ batchId: id, settings: store.getState().draft!.settings })
  return id
}

describe('batch workflow', () => {
  it('requires a ready selection and a previous commit for the shortcut', () => {
    store.setState({ selectedIds: new Set() })
    render(<Toolbar />)
    expect((screen.getByText('Convert') as HTMLButtonElement).disabled).toBe(true)
    const dropdown = screen.getByRole('button', { name: 'Conversion options' }) as HTMLButtonElement
    expect(dropdown.disabled).toBe(true)
    fireEvent.click(dropdown)
    expect(screen.queryByRole('menu')).toBeNull()
    store.getState().openExport()
    expect(store.getState().draft).toBeNull()
    act(() =>
      store.setState({
        selectedIds: new Set(['a']),
        files: files.map((f) => ({ ...f, pending: true }))
      })
    )
    expect((screen.getByText('Convert') as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens the joined dropdown with the keyboard and disables both halves while converting', () => {
    render(<Toolbar />)
    const dropdown = screen.getByRole('button', { name: 'Conversion options' }) as HTMLButtonElement
    const convert = screen.getByText('Convert') as HTMLButtonElement
    expect(dropdown.disabled).toBe(false)
    expect(dropdown.previousElementSibling).toBe(convert)
    fireEvent.keyDown(dropdown, { key: 'ArrowDown' })
    const previous = screen.getByRole('menuitem', { name: 'Convert with Previous Settings' })
    expect(previous.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(previous)
    expect(invoke).not.toHaveBeenCalled()
    fireEvent.keyDown(previous, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(dropdown)
    act(() =>
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, hasPreviousConversion: true } })
    )
    fireEvent.click(dropdown)
    expect(screen.getByRole('menuitem').getAttribute('aria-disabled')).toBe('false')
    act(() => store.setState({ isProcessing: true }))
    expect(convert.disabled).toBe(true)
    expect(dropdown.disabled).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows radial progress and a short counter, with Stop only inside the modal', async () => {
    await start()
    render(<Toolbar />)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Conversion status: 0 of 2' })
    expect(trigger.querySelector('svg[role="progressbar"]')).not.toBeNull()
    fireEvent.click(trigger)
    const stop = screen.getByRole('button', { name: 'Stop' })
    fireEvent.click(stop)
    expect(invoke).toHaveBeenLastCalledWith('convert:stop')
    expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  it('only renders the changed visible row during progress updates in a large batch', async () => {
    const largeBatch = Array.from({ length: 1000 }, (_, index) => {
      const id = String(index).padStart(4, '0')
      return { id, path: `/photos/${id}.X3F`, fileName: `${id}.X3F` }
    })
    store.setState({ files: largeBatch, selectedIds: new Set(largeBatch.map((f) => f.id)) })
    const batchId = await start()
    render(<BatchProgress />)
    fireEvent.click(screen.getByRole('button', { name: 'Conversion status: 0 of 1000' }))
    const list = screen.getByRole('list')
    const viewport = list.parentElement!
    expect(screen.getAllByRole('listitem').length).toBeLessThan(25)
    expect(screen.getByText('0000.dng')).toBeTruthy()
    expect(screen.queryByText('0999.dng')).toBeNull()

    // Each row translates its status when it renders; unchanged rows must bail out.
    const translate = vi.spyOn(strings, 't')
    act(() => store.getState().applyProgress({ batchId, id: '0000', progress: 0.5 }))
    expect(translate.mock.calls.filter(([key]) => key.startsWith('batch.status.'))).toHaveLength(1)
    translate.mockClear()
    act(() =>
      store.getState().applyStatus({
        batchId,
        id: '0999',
        status: 'failed',
        message: 'Broken input'
      })
    )
    expect(translate.mock.calls.filter(([key]) => key.startsWith('batch.status.'))).toHaveLength(0)

    fireEvent.scroll(viewport, { target: { scrollTop: 41 * 1000 - 240 } })
    expect(screen.getByText('0999.dng')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Failed: Broken input' })).toBeTruthy()
    expect(screen.queryByText('0000.dng')).toBeNull()
    expect(screen.getAllByRole('listitem').length).toBeLessThan(25)
    expect(screen.getByText('0999.dng').closest('li')?.getAttribute('aria-posinset')).toBe('1000')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(invoke).toHaveBeenLastCalledWith('convert:stop')
  })

  it.each([
    { warnings: 0, failed: 0, cancelled: false, icon: '.lucide-check' },
    { warnings: 1, failed: 0, cancelled: false, icon: '.lucide-triangle-alert' },
    { warnings: 0, failed: 1, cancelled: false, icon: '.lucide-triangle-alert' },
    { warnings: 0, failed: 0, cancelled: true, icon: '.lucide-circle-slash' }
  ])(
    'uses an icon for completed conversion status (%j)',
    async ({ warnings, failed, cancelled, icon }) => {
      const batchId = await start()
      store
        .getState()
        .onBatchComplete({ batchId, completed: 2 - failed, failed, warnings, total: 2, cancelled })
      render(<BatchProgress />)
      const trigger = screen.getByRole('button')
      const glyph = trigger.querySelector(icon)
      expect(glyph).not.toBeNull()
      if (warnings || failed) expect(glyph?.classList.contains('text-red-400')).toBe(true)
      expect(trigger.querySelector('[role="status"]')?.classList.contains('sr-only')).toBe(true)
      expect(screen.queryByRole('progressbar')).toBeNull()
    }
  )

  it('captures sorted targets and discards draft settings on Back without persistence', () => {
    store.getState().openExport()
    expect(store.getState().draft?.files.map((f) => f.id)).toEqual(['a', 'b'])
    store.getState().updateDraft({ outputFormat: 'tiff', outputDirectory: '/new' })
    store.getState().setSelection(new Set(['c']))
    store.getState().removeSelected()
    expect(store.getState().files).toBe(files)
    expect(store.getState().draft?.files.map((f) => f.id)).toEqual(['a', 'b'])
    store.getState().cancelExport()
    expect(useNavStore.getState().screen).toBe('queue')
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('checks every target with the draft and converts the whole batch after confirmation', async () => {
    invoke.mockResolvedValueOnce([{ id: 'a', outputPath: '/new/a.X3F.tif' }])
    store.getState().openExport()
    store.getState().updateDraft({ outputFormat: 'tiff', outputDirectory: '/new' })
    await store.getState().commitExport()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('queue:existingOutputs', {
      files: [
        { id: 'a', path: '/photos/a.X3F' },
        { id: 'b', path: '/photos/b.X3F' }
      ],
      settings: { ...settings, outputFormat: 'tiff', outputDirectory: '/new' }
    })
    await store.getState().commitExport() // repeated click cannot start twice
    store.getState().confirmReconversion()
    store.getState().confirmReconversion()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith(
      'convert:start',
      expect.objectContaining({
        files: [
          { id: 'a', path: '/photos/a.X3F' },
          { id: 'b', path: '/photos/b.X3F' }
        ],
        settings: { ...settings, outputFormat: 'tiff', outputDirectory: '/new' },
        replaceExisting: true
      })
    )
    expect(useSettingsStore.getState().settings.hasPreviousConversion).toBe(false)
  })

  it('uses saved settings without opening export and cancels conflicts without saving', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, hasPreviousConversion: true, outputDirectory: '/saved' }
    })
    invoke.mockResolvedValueOnce([{ id: 'a', outputPath: '/saved/a.dng' }])
    await store.getState().convertPrevious()
    expect(useNavStore.getState().screen).toBe('queue')
    expect(store.getState().draft?.settings.outputDirectory).toBe('/saved')
    store.getState().cancelReconversion()
    expect(store.getState().draft).toBeNull()
    expect(store.getState().isPreparing).toBe(false)
    expect(invoke).toHaveBeenCalledTimes(1)
    await store.getState().convertPrevious()
    expect(invoke).toHaveBeenLastCalledWith(
      'convert:start',
      expect.objectContaining({ settings: { ...settings, outputDirectory: '/saved' } })
    )
  })

  it('keeps recoverable validation and start errors on the draft', async () => {
    store.getState().openExport()
    invoke.mockRejectedValueOnce(new Error('Destination unavailable'))
    await store.getState().commitExport()
    expect(store.getState().isPreparing).toBe(false)
    expect(store.getState().error).toContain('Destination unavailable')
    expect(store.getState().draft).not.toBeNull()
    invoke.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Start rejected'))
    await store.getState().commitExport()
    await Promise.resolve()
    expect(store.getState().error).toContain('Start rejected')
    expect(store.getState().isProcessing).toBe(false)
    expect(useSettingsStore.getState().settings.hasPreviousConversion).toBe(false)
    store.getState().cancelExport()
    expect(store.getState().draft).toBeNull()
  })

  it.each([
    ['dng', 'a.dng'],
    ['tiff', 'a.X3F.tif'],
    ['embeddedJpg', 'a.X3F.jpg']
  ] as const)(
    'shows the batch output filename for %s before the output exists',
    async (outputFormat, expected) => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, outputFormat } })
      await start()
      // Later preferences must not rename an existing batch's rows.
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, outputFormat: 'embeddedJpg' } })
      render(<BatchProgress />)
      fireEvent.click(screen.getByRole('button', { name: 'Conversion status: 0 of 2' }))
      expect(screen.getByText(expected)).toBeTruthy()
      expect(screen.queryByText('a.X3F')).toBeNull()
      expect(store.getState().files).toBe(files)
    }
  )

  it('aggregates parallel progress and failures without changing browsing records', async () => {
    const id = await start()
    expect(useNavStore.getState().screen).toBe('queue')
    expect(useSettingsStore.getState().settings.hasPreviousConversion).toBe(true)
    store.getState().setSelection(new Set(['c']))
    store.getState().applyProgress({ batchId: id, id: 'a', progress: 0.7 })
    store.getState().applyProgress({ batchId: id, id: 'b', progress: 0.3 })
    render(<BatchProgress />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    act(() =>
      store
        .getState()
        .applyStatus({ batchId: id, id: 'b', status: 'failed', message: 'Broken input' })
    )
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('85')
    act(() => {
      store
        .getState()
        .applyStatus({ batchId: id, id: 'a', status: 'completed', outputPath: '/photos/a.dng' })
      store.getState().onBatchComplete({
        batchId: id,
        cancelled: false,
        completed: 1,
        failed: 1,
        warnings: 0,
        total: 2
      })
    })
    expect(store.getState().files).toBe(files)
    expect(screen.queryByRole('progressbar')).toBeNull()
    const trigger = screen.getByRole('button', {
      name: 'Conversion status: 1 converted · 1 failed · 0 warnings'
    })
    expect(trigger.querySelector('.lucide-triangle-alert')).not.toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Conversion status' })).toBeTruthy()
    const status = screen.getByRole('img', { name: 'Failed: Broken input' })
    act(() => status.focus())
    expect((await screen.findByRole('tooltip')).textContent).toContain('Failed: Broken input')
    const reveal = screen.getByRole('button', { name: 'Show output in file manager' })
    expect(reveal.textContent).toBe('')
    expect(reveal.parentElement?.textContent).toBe('a.dng')
    expect(reveal.nextElementSibling?.getAttribute('aria-label')).toBe('Completed')
    fireEvent.click(reveal)
    expect(invoke).toHaveBeenLastCalledWith('shell:reveal', { path: '/photos/a.dng' })
  })

  it('reports cancelled and unstarted files and ignores stale events', async () => {
    const id = await start()
    store.getState().applyStatus({ batchId: id, id: 'a', status: 'processing' })
    store.getState().stop()
    expect(invoke).toHaveBeenLastCalledWith('convert:stop')
    store.getState().applyStatus({ batchId: id, id: 'a', status: 'queued' })
    store.getState().onBatchComplete({
      batchId: id,
      cancelled: true,
      completed: 0,
      failed: 0,
      warnings: 0,
      total: 2
    })
    expect(store.getState().batch?.results.map((r) => r.status)).toEqual(['cancelled', 'unstarted'])
    const results = store.getState().batch
    store.getState().applyProgress({ batchId: id, id: 'a', progress: 1 })
    store.getState().onBatchComplete({
      batchId: 'old',
      cancelled: false,
      completed: 2,
      failed: 0,
      warnings: 0,
      total: 2
    })
    expect(store.getState().batch).toBe(results)
    expect(store.getState().files).toBe(files)
  })

  it('routes Convert All through the export screen', () => {
    store.getState().convertAllMenu()
    expect(store.getState().selectedIds.size).toBe(3)
    expect(store.getState().draft?.files).toHaveLength(3)
    expect(useNavStore.getState().screen).toBe('export')
    expect(invoke).not.toHaveBeenCalled()
  })
})
