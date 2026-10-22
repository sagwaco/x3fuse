// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { SettingsWindow } from '../src/renderer/src/components/SettingsWindow'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { memo } from 'react'
import { t, useLanguage } from '../src/renderer/src/lib/strings'
import { applyLanguage } from '../src/renderer/src/i18n/config'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke, on: () => () => {} } }))

const originalState = useSettingsStore.getState()
let cacheSize = 0
let sfdSize = 240_000_000
const update = vi.fn<typeof originalState.update>().mockResolvedValue(undefined)

beforeEach(async () => {
  localStorage.clear()
  sfdSize = 240_000_000
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    loaded: true,
    load: vi.fn().mockResolvedValue(undefined),
    update
  })
  invoke.mockImplementation(async (channel) => {
    if (channel === 'app:info') return { version: '1.0' }
    if (channel === 'logs:sizes') return { conversion: 0, error: 0, debug: 0 }
    if (channel === 'cache:size') return cacheSize
    if (channel === 'cache:sfdSize') return sfdSize
    return null
  })
  await act(async () => {
    render(<SettingsWindow />)
  })
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(originalState, true)
  vi.clearAllMocks()
})

it.each([
  ['auto', 'settings.appearance.auto'],
  ['light', 'theme.light'],
  ['dark', 'theme.dark']
] as const)('writes the %s appearance mode', (mode, label) => {
  const group = screen.getByRole('group', { name: t('settings.appearance.mode') })
  expect(within(group).getByRole('button', { pressed: true }).textContent).toBe(t('theme.dark'))
  fireEvent.click(within(group).getByRole('button', { name: t(label) }))
  expect(update).toHaveBeenCalledWith({ appearanceMode: mode })
})

it.each([
  ['lightTheme', 'settings.appearance.light_theme', ['light', 'gray', 'dark']],
  ['darkTheme', 'settings.appearance.dark_theme', ['dark', 'gray', 'light']]
] as const)('writes %s through its theme menu', async (key, label, order) => {
  const select = screen.getByRole('button', { name: t(label) })
  expect((select as HTMLButtonElement).disabled).toBe(false)
  invoke.mockResolvedValueOnce('gray')
  fireEvent.keyDown(select, { key: 'ArrowDown' })
  expect(invoke).toHaveBeenCalledWith(
    'menu:popup',
    expect.objectContaining({
      items: order.map((value) => ({
        value,
        label: t(`theme.${value}`),
        checked: value === DEFAULT_SETTINGS[key]
      }))
    })
  )
  await waitFor(() => expect(update).toHaveBeenCalledWith({ [key]: 'gray' }))
})

it('writes the language through its menu, with each language in its own name', async () => {
  const select = screen.getByRole('button', { name: t('settings.language') })
  expect(select.textContent).toBe(t('settings.language.auto'))
  invoke.mockResolvedValueOnce('ko')
  fireEvent.keyDown(select, { key: 'ArrowDown' })
  expect(invoke).toHaveBeenCalledWith(
    'menu:popup',
    expect.objectContaining({
      items: [
        { value: 'auto', label: t('settings.language.auto'), checked: true },
        ...['English', 'Español', '日本語', '한국어', '简体中文', '繁體中文'].map((label) =>
          expect.objectContaining({ label, checked: false })
        )
      ]
    })
  )
  await waitFor(() => expect(update).toHaveBeenCalledWith({ language: 'ko' }))
})

it('renders memo components again in a new language', async () => {
  const Label = memo(function Label() {
    useLanguage()
    return <p>{t('settings.language')}</p>
  })
  const { container } = render(<Label />)
  await act(() => applyLanguage('ja'))
  expect(container.textContent).toBe('言語')
  expect(document.documentElement.lang).toBe('ja')
  await act(() => applyLanguage('auto'))
  expect(container.textContent).toBe('Language')
})

const tabNames = ['appearance', 'cache', 'advanced', 'updates', 'about'].map((key) =>
  t(`settings.section.${key}`)
)
const title = (): string | null => screen.getByRole('heading', { level: 1 }).textContent

it('opens on the Appearance tab with its controls', () => {
  const tabs = screen.getAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual(tabNames)
  expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tabpanel').contains(screen.getByRole('group'))).toBe(true)
  expect(title()).toBe(t('settings.section.appearance'))
  // Tauri drags only on direct hits, so the title row and the title both carry the region.
  const heading = screen.getByRole('heading', { level: 1 })
  expect(heading.hasAttribute('data-tauri-drag-region')).toBe(true)
  expect(heading.parentElement!.hasAttribute('data-tauri-drag-region')).toBe(true)
})

it('shows the update toggles on the Updates tab and remembers it', async () => {
  fireEvent.click(screen.getByRole('tab', { name: t('settings.section.updates') }))
  expect(screen.getByRole('switch', { name: t('updates.automatic_updates') })).toBeTruthy()
  expect(screen.getByRole('switch', { name: t('updates.automatic_download') })).toBeTruthy()
  expect(screen.queryByRole('group', { name: t('settings.appearance.mode') })).toBeNull()
  expect(title()).toBe(t('settings.section.updates'))
  cleanup()
  await act(async () => {
    render(<SettingsWindow />)
  })
  expect(screen.getByRole('tab', { selected: true }).textContent).toBe(
    t('settings.section.updates')
  )
})

it('moves the selection with the arrow keys', () => {
  const selected = (): string | null => screen.getByRole('tab', { selected: true }).textContent
  fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowRight' })
  expect(selected()).toBe(t('settings.section.cache'))
  expect(document.activeElement?.textContent).toBe(t('settings.section.cache'))
  expect(title()).toBe(t('settings.section.cache'))
  fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowLeft' })
  fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowLeft' })
  expect(selected()).toBe(t('settings.section.about'))
  expect(title()).toBe(t('settings.section.about'))
})

it('edits simultaneous exports in Advanced and retains the debug controls', async () => {
  fireEvent.click(screen.getByRole('tab', { name: t('settings.section.advanced') }))
  const concurrency = screen.getByRole('button', {
    name: t('settings.concurrency'),
    exact: true,
    expanded: false
  })
  expect(screen.getByRole('switch', { name: t('settings.debug_logging') })).toBeTruthy()
  invoke.mockResolvedValueOnce('2')
  fireEvent.click(concurrency)
  await waitFor(() => expect(update).toHaveBeenCalledWith({ concurrency: 2 }))
  expect(invoke).toHaveBeenCalledWith(
    'menu:popup',
    expect.objectContaining({
      items: expect.arrayContaining([
        expect.objectContaining({ value: '0', checked: true }),
        expect.objectContaining({ value: '8' })
      ])
    })
  )
  invoke.mockResolvedValueOnce(null)
  fireEvent.click(concurrency)
  await waitFor(() => expect(concurrency.getAttribute('aria-expanded')).toBe('false'))
  expect(update).toHaveBeenCalledTimes(1)
})

it('opens the Advanced tab when the previous Debug tab was stored', async () => {
  cleanup()
  localStorage.setItem('x3fuse.settingsTab', 'debug')
  await act(async () => {
    render(<SettingsWindow />)
  })
  expect(screen.getByRole('tab', { selected: true }).textContent).toBe(
    t('settings.section.advanced')
  )
  expect(
    screen.getByRole('button', { name: t('settings.concurrency'), exact: true, expanded: false })
  ).toBeTruthy()
})

describe('Cache tab', () => {
  const sizeRequests = (): number => invoke.mock.calls.filter(([c]) => c === 'cache:size').length

  beforeEach(async () => {
    cacheSize = 12_300_000
    fireEvent.click(screen.getByRole('tab', { name: t('settings.section.cache') }))
    await screen.findByText('12.3 MB')
  })

  afterEach(() => {
    cacheSize = 0
  })

  it('shows the used size and refreshes it on focus', async () => {
    expect(title()).toBe(t('settings.section.cache'))
    expect(screen.getByText(t('settings.cache.title'))).toBeTruthy()
    cacheSize = 5_000_000
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await screen.findByText('5 MB')
  })

  it('clears the cache and then shows the new size', async () => {
    const before = sizeRequests()
    cacheSize = 0
    fireEvent.click(screen.getByRole('button', { name: t('settings.cache.clear') }))
    await screen.findByText('0 bytes')
    expect(invoke).toHaveBeenCalledWith('cache:clear')
    expect(sizeRequests()).toBe(before + 1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows an error when Clear fails, and hides it on the next try', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = sizeRequests()
    invoke.mockRejectedValueOnce(new Error('Permission denied'))
    const clear = screen.getByRole('button', { name: t('settings.cache.clear') })
    fireEvent.click(clear)
    expect((await screen.findByRole('alert')).textContent).toBe(t('settings.cache.clear_failed'))
    expect(error).toHaveBeenCalled()
    await waitFor(() => expect(sizeRequests()).toBe(before + 1))
    fireEvent.click(clear)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    error.mockRestore()
  })

  it('allows one Clear at a time', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail!: (reason: Error) => void
    invoke.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
    const clear = screen.getByRole('button', { name: t('settings.cache.clear') })
    fireEvent.click(clear)
    expect((clear as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(clear)
    expect(invoke.mock.calls.filter(([c]) => c === 'cache:clear')).toHaveLength(1)
    await act(async () => fail(new Error('Permission denied')))
    await screen.findByRole('alert')
    expect((clear as HTMLButtonElement).disabled).toBe(false)
    error.mockRestore()
  })

  it('writes the switch and the limit, and refreshes the size after a new limit', async () => {
    fireEvent.click(screen.getByRole('switch', { name: t('settings.cache.enabled') }))
    expect(update).toHaveBeenCalledWith({ previewCacheEnabled: false })

    const select = screen.getByRole('button', { name: t('settings.cache.limit') })
    expect(select.textContent).toBe('1 GB')
    const before = sizeRequests()
    invoke.mockResolvedValueOnce(String(256e6))
    fireEvent.keyDown(select, { key: 'ArrowDown' })
    expect(invoke).toHaveBeenCalledWith(
      'menu:popup',
      expect.objectContaining({
        items: ['256 MB', '512 MB', '1 GB', '2 GB', '5 GB'].map((label, index) =>
          expect.objectContaining({ label, checked: index === 2 })
        )
      })
    )
    await waitFor(() => expect(update).toHaveBeenCalledWith({ previewCacheLimit: 256e6 }))
    await waitFor(() => expect(sizeRequests()).toBe(before + 1))
  })
})

describe('SFD cache', () => {
  beforeEach(async () => {
    cacheSize = 12_300_000
    fireEvent.click(screen.getByRole('tab', { name: t('settings.section.cache') }))
    await screen.findByText('240 MB')
  })

  it('clears SFD scenes independently and refreshes their size', async () => {
    let finish!: () => void
    invoke.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)))
    const clear = screen.getByRole('button', { name: t('settings.sfd_cache.clear') })
    fireEvent.click(clear)
    expect((clear as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(clear)
    expect(invoke.mock.calls.filter(([c]) => c === 'cache:sfdClear')).toHaveLength(1)
    expect(invoke).not.toHaveBeenCalledWith('cache:clear')
    sfdSize = 0
    await act(async () => finish())
    await screen.findByText('0 bytes')
    expect(screen.getByText('12.3 MB')).toBeTruthy()
    expect((clear as HTMLButtonElement).disabled).toBe(false)
  })

  it('refreshes SFD usage on focus and reports a failed clear', async () => {
    sfdSize = 480_000_000
    fireEvent(window, new Event('focus'))
    await screen.findByText('480 MB')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockRejectedValueOnce(new Error('Merge in progress'))
    const clear = screen.getByRole('button', { name: t('settings.sfd_cache.clear') })
    fireEvent.click(clear)
    expect((await screen.findByRole('alert')).textContent).toBe(
      t('settings.sfd_cache.clear_failed')
    )
    expect(screen.getByText('480 MB')).toBeTruthy()
    fireEvent.click(clear)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    error.mockRestore()
  })
})
