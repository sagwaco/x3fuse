// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { SettingsWindow } from '../src/renderer/src/components/SettingsWindow'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { t } from '../src/renderer/src/lib/strings'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke, on: () => () => {} } }))

const originalState = useSettingsStore.getState()
const update = vi.fn<typeof originalState.update>().mockResolvedValue(undefined)

beforeEach(async () => {
  localStorage.clear()
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    loaded: true,
    load: vi.fn().mockResolvedValue(undefined),
    update
  })
  invoke.mockImplementation(async (channel) => {
    if (channel === 'app:info') return { version: '1.0' }
    if (channel === 'logs:sizes') return { conversion: 0, error: 0, debug: 0 }
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
  expect(within(group).getByRole('button', { pressed: true }).textContent).toBe(
    t('settings.appearance.auto')
  )
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

const tabNames = ['appearance', 'debug', 'updates', 'about'].map((key) =>
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
  expect(selected()).toBe(t('settings.section.debug'))
  expect(document.activeElement?.textContent).toBe(t('settings.section.debug'))
  expect(title()).toBe(t('settings.section.debug'))
  fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowLeft' })
  fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowLeft' })
  expect(selected()).toBe(t('settings.section.about'))
  expect(title()).toBe(t('settings.section.about'))
})
