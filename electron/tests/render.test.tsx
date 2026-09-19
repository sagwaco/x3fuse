// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, renderHook, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'

/**
 * Renderer smoke test: mounts the real component tree (stores + IPC hook + Radix)
 * against a mocked `window.x3f` bridge to catch render-time throws that the dev
 * boot log can't surface. Set the bridge before any module that reads it at load.
 */
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  switch (channel) {
    case 'settings:get':
    case 'settings:set':
      return DEFAULT_SETTINGS
    case 'queue:add':
    case 'queue:existingOutputs':
      return []
    case 'app:info':
      return { version: '0.1.0' }
    case 'logs:sizes':
      return { conversion: 0, error: 0, debug: 0 }
    default:
      return undefined
  }
})

// lib/ipc.ts reads window.x3f at module-eval time, so define it first.
;(window as unknown as { x3f: unknown }).x3f = {
  invoke,
  on: () => () => {},
  pathForFile: () => ''
}

// jsdom lacks APIs Radix uses on mount (Switch measures via ResizeObserver).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
if (!window.matchMedia) {
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {}
    }) as unknown as MediaQueryList
}

beforeEach(async () => {
  const { useQueueStore } = await import('../src/renderer/src/stores/queueStore')
  const { useNavStore } = await import('../src/renderer/src/stores/navStore')
  useQueueStore.setState({
    files: [],
    selectedIds: new Set(),
    activeId: null,
    draft: null,
    batch: null,
    error: null,
    isProcessing: false,
    isCancelling: false,
    isPreparing: false,
    pendingReconversion: null
  })
  useNavStore.setState({ screen: 'queue' })
  invoke.mockClear()
})
afterEach(() => cleanup())

describe('renderer smoke', () => {
  it('populates Info on first import and keeps its selection when more files arrive', async () => {
    const { useQueueStore } = await import('../src/renderer/src/stores/queueStore')
    const { Inspector } = await import('../src/renderer/src/components/Inspector')
    useQueueStore.setState({ files: [], selectedIds: new Set(), activeId: null })
    render(<Inspector />)
    expect(screen.getByText('Select a file to see its details')).toBeTruthy()

    const file: X3FFileDTO = {
      id: 'from-main',
      path: '/photos/first.X3F',
      fileName: 'first.X3F',
      fileSize: 1000
    }
    let finishImport!: (files: X3FFileDTO[]) => void
    invoke.mockReturnValueOnce(
      new Promise<X3FFileDTO[]>((resolve) => {
        finishImport = resolve
      })
    )
    invoke.mockResolvedValueOnce([{ label: 'Camera', value: 'Sigma DP2 Merrill' }])
    let importing!: Promise<void>
    await act(async () => {
      importing = useQueueStore.getState().addFiles([file.path])
    })
    const activeId = useQueueStore.getState().activeId
    expect(activeId).toBe(useQueueStore.getState().files[0].id)
    expect(useQueueStore.getState().selectedIds).toEqual(new Set([activeId]))
    expect(screen.getByText('first.X3F')).toBeTruthy()
    expect(screen.getByText('Sigma DP2 Merrill')).toBeTruthy()

    await act(async () => {
      finishImport([file])
      await importing
    })
    expect(useQueueStore.getState().activeId).toBe(activeId)
    expect(useQueueStore.getState().files[0].pending).toBe(false)
    expect(screen.getByRole('img', { name: 'first.X3F' })).toBeTruthy()
    invoke.mockResolvedValueOnce([{ ...file, path: '/photos/second.X3F' }])
    await act(async () => useQueueStore.getState().addFiles(['/photos/second.X3F']))
    expect(useQueueStore.getState().activeId).toBe(activeId)
    expect(screen.getByText('first.X3F')).toBeTruthy()
    useQueueStore.setState({ files: [], selectedIds: new Set(), activeId: null })
  })

  it.each(['rejected', 'empty'] as const)(
    'clears the initial selection after a %s import',
    async (result) => {
      const { useQueueStore } = await import('../src/renderer/src/stores/queueStore')
      useQueueStore.setState({ files: [], selectedIds: new Set(), activeId: null })
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        if (result === 'rejected') invoke.mockRejectedValueOnce(new Error('Import failed'))
        else invoke.mockResolvedValueOnce([])
        await useQueueStore.getState().addFiles(['/photos/first.X3F'])
        expect(useQueueStore.getState().files).toEqual([])
        expect(useQueueStore.getState().selectedIds.size).toBe(0)
        expect(useQueueStore.getState().activeId).toBeNull()
      } finally {
        errorLog.mockRestore()
      }
    }
  )

  it.each(['list', 'grid'] as const)(
    'opens a double-clicked %s item in filmstrip without converting',
    async (mode) => {
      const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
      const { useQueueStore } = await import('../src/renderer/src/stores/queueStore')
      const { useQueueSelection } = await import('../src/renderer/src/hooks/useQueueSelection')
      const files: X3FFileDTO[] = ['a', 'b'].map((id) => ({
        id,
        path: `/photos/${id}.X3F`,
        fileName: `${id}.X3F`
      }))
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, queueViewMode: mode } })
      useQueueStore.setState({
        files,
        selectedIds: new Set(['a', 'b']),
        activeId: 'a',
        isProcessing: false
      })
      const { result } = renderHook(() =>
        useQueueSelection(
          files,
          mode === 'list' ? { mode: 'vertical' } : { mode: 'grid', columns: 2 }
        )
      )
      invoke.mockClear()
      invoke.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, queueViewMode: 'filmstrip' })
      await act(async () => result.current.handleItemDoubleClick('b'))
      expect(useSettingsStore.getState().settings.queueViewMode).toBe('filmstrip')
      expect(useQueueStore.getState().activeId).toBe('b')
      expect(useQueueStore.getState().selectedIds).toEqual(new Set(['a', 'b']))
      expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['settings:set'])
      useQueueStore.setState({ files: [], selectedIds: new Set(), activeId: null })
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
    }
  )

  it('keeps toolbar controls in order and disables them when the queue empties', async () => {
    const { Toolbar } = await import('../src/renderer/src/components/Toolbar')
    const { useQueueStore } = await import('../src/renderer/src/stores/queueStore')
    const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, inspectorOpen: false },
      loaded: true
    })
    const { container } = render(<Toolbar />)
    const controls = Array.from(container.querySelectorAll('button, [role="separator"]'))
    const order = controls.map(
      (element) =>
        element.getAttribute('aria-label') ??
        element.getAttribute('title') ??
        element.getAttribute('role') ??
        element.textContent
    )
    expect(order).toEqual([
      'List view',
      'Grid view',
      'Filmstrip view',
      'separator',
      'Zoom out',
      'Zoom in',
      'Zoom level',
      'Convert selected',
      'Conversion options',
      'Toggle info panel'
    ])
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[]
    for (const button of buttons) {
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }
    expect(invoke).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().settings).toEqual({
      ...DEFAULT_SETTINGS,
      inspectorOpen: false
    })

    act(() =>
      useQueueStore.setState({
        files: [{ id: 'a', path: '/a.X3F', fileName: 'a.X3F' }],
        selectedIds: new Set(['a']),
        activeId: 'a'
      })
    )
    for (const title of [
      'List view',
      'Grid view',
      'Filmstrip view',
      'Convert selected',
      'Toggle info panel'
    ]) {
      expect((screen.getByTitle(title) as HTMLButtonElement).disabled).toBe(false)
    }
    expect(
      (screen.getByRole('button', { name: 'Conversion options' }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect((screen.getByRole('button', { name: 'Zoom level' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    invoke.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, inspectorOpen: true })
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Toggle info panel' }))
    )
    expect(useSettingsStore.getState().settings.inspectorOpen).toBe(true)
    act(() => useQueueStore.getState().clearQueue())
    expect(Array.from(container.querySelectorAll('button, [role="separator"]'))).toEqual(controls)
    expect(buttons.every((button) => button.disabled)).toBe(true)
    expect(useSettingsStore.getState().settings.inspectorOpen).toBe(true)
    expect(useSettingsStore.getState().settings.queueViewMode).toBe(DEFAULT_SETTINGS.queueViewMode)
  })

  it('mounts MainWindow with the empty drop zone', async () => {
    const { MainWindow } = await import('../src/renderer/src/components/MainWindow')
    render(<MainWindow />)
    expect(screen.getByText('No files in queue')).toBeTruthy()
    expect(screen.getByText('Convert')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Toggle info panel' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(screen.queryByTitle('Add files')).toBeNull()
    expect(screen.queryByTitle('Settings')).toBeNull()
  })

  it('navigates to the Export screen when the toolbar Convert is clicked', async () => {
    const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })

    const file: X3FFileDTO = {
      id: 'a',
      path: '/photos/IMG_0001.X3F',
      fileName: 'IMG_0001.X3F'
    }
    const { useQueueStore } = await import('../src/renderer/src/stores/queueStore')
    useQueueStore.setState({ files: [file], selectedIds: new Set(['a']), activeId: 'a' })

    const { useNavStore } = await import('../src/renderer/src/stores/navStore')
    useNavStore.setState({ screen: 'queue' })

    // Render the toolbar in isolation so the test doesn't depend on the queue
    // body's virtualization; clicking Convert should flip the nav store.
    const { Toolbar } = await import('../src/renderer/src/components/Toolbar')
    render(<Toolbar />)
    fireEvent.click(screen.getByText('Convert'))
    expect(useNavStore.getState().screen).toBe('export')
  })

  it('shows previews and settings on the Export screen', async () => {
    const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })

    const file: X3FFileDTO = {
      id: 'a',
      path: '/photos/IMG_0001.X3F',
      fileName: 'IMG_0001.X3F'
    }
    const { useQueueStore } = await import('../src/renderer/src/stores/queueStore')
    useQueueStore.setState({ files: [file], selectedIds: new Set(['a']), activeId: 'a' })

    const { useNavStore } = await import('../src/renderer/src/stores/navStore')
    useQueueStore.getState().openExport()
    expect(useNavStore.getState().screen).toBe('export')

    const { MainWindow } = await import('../src/renderer/src/components/MainWindow')
    render(<MainWindow />)
    expect(screen.queryByText('Export')).toBeNull()
    expect(screen.getByText('Images to convert')).toBeTruthy()
    expect(screen.getByText('Output & conversion settings')).toBeTruthy()
  })

  it('mounts the Settings window with its sections', async () => {
    const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
    // Settings window gates on `loaded`; prime it so sections render synchronously.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })

    const { SettingsWindow } = await import('../src/renderer/src/components/SettingsWindow')
    render(<SettingsWindow />)
    expect(screen.queryByText('Output settings')).toBeNull()
    expect(screen.queryByText('Conversion settings')).toBeNull()
    expect(screen.getByText('Debug')).toBeTruthy()
  })

  it('refreshes an existing Settings window on focus and unsubscribes on unmount', async () => {
    const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
    const { SettingsWindow } = await import('../src/renderer/src/components/SettingsWindow')
    const view = render(<SettingsWindow />)
    await act(async () => {})
    expect(useSettingsStore.getState().settings.outputFormat).toBe('dng')

    invoke.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, outputFormat: 'tiff' })
    await act(async () => fireEvent.focus(window))
    expect(useSettingsStore.getState().settings.outputFormat).toBe('tiff')

    view.unmount()
    invoke.mockClear()
    fireEvent.focus(window)
    expect(invoke).not.toHaveBeenCalled()
  })
})
