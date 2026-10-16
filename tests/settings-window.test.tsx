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
