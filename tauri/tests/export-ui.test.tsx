// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { ExportScreen } from '../src/renderer/src/components/ExportScreen'
import { useQueueStore } from '../src/renderer/src/stores/queueStore'
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
  expect(screen.getByText('→ a.dng')).toBeTruthy()
  expect(screen.queryByText('excluded.X3F')).toBeNull()
  const cancel = screen.getByRole('button', { name: 'Cancel' })
  const exportButton = screen.getByRole('button', { name: 'Export', exact: true })
  expect(cancel.nextElementSibling).toBe(exportButton)
  expect(cancel.querySelector('svg')).toBeNull()
  expect(exportButton.querySelector('.lucide-upload')).toBeTruthy()

  fireEvent.click(screen.getByTitle(t('view.grid')))
  await waitFor(() =>
    expect(screen.getByTitle(t('view.grid')).getAttribute('aria-pressed')).toBe('true')
  )
  expect(screen.queryByRole('button', { name: 'Name' })).toBeNull()
  expect(screen.getByText('→ b.dng')).toBeTruthy()
  expect(screen.queryByText('excluded.X3F')).toBeNull()
  fireEvent.doubleClick(screen.getByText('b.X3F'))
  await waitFor(() =>
    expect(screen.getByTitle(t('view.filmstrip')).getAttribute('aria-pressed')).toBe('true')
  )
  expect(screen.getByText('b.X3F → b.dng')).toBeTruthy()
  const surface = document.activeElement as HTMLElement
  act(() => surface.blur())
  fireEvent.keyDown(document.body, { key: 'ArrowRight' })
  expect(useQueueStore.getState().activeId).toBe('b')
  fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
  expect(screen.getByText('a.X3F → a.dng')).toBeTruthy()
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
  const concurrency = screen
    .getAllByRole('button', { name: t('settings.concurrency'), exact: true })
    .find((button) => button.getAttribute('aria-haspopup') === 'menu')!
  invoke.mockResolvedValueOnce('2')
  fireEvent.keyDown(concurrency, { key: 'ArrowDown' })
  await waitFor(() => expect(useQueueStore.getState().draft!.settings.concurrency).toBe(2))
  invoke.mockResolvedValueOnce(null)
  fireEvent.click(concurrency)
  await waitFor(() => expect(concurrency.getAttribute('aria-expanded')).toBe('false'))
  expect(useQueueStore.getState().draft!.settings.concurrency).toBe(2)
})
