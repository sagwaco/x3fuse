// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { QuickLookStatus } from '@shared/ipc'
import { SettingsWindow } from '../src/renderer/src/components/SettingsWindow'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { appInfo } from '../src/renderer/src/lib/appInfo'
import { t } from '../src/renderer/src/lib/strings'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke, on: () => () => {} } }))

const originalState = useSettingsStore.getState()

async function show(status: QuickLookStatus): Promise<void> {
  appInfo.platform = 'darwin'
  localStorage.setItem('x3fuse.settingsTab', 'advanced')
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    loaded: true,
    load: vi.fn().mockResolvedValue(undefined)
  })
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'app:info') return { version: '1.0' }
    if (channel === 'logs:sizes') return { conversion: 0, error: 0, debug: 0 }
    if (channel === 'quickLook:status') return status
    if (channel === 'quickLook:set') return { state: 'off', conflicts: [] }
    return null
  })
  await act(async () => {
    render(<SettingsWindow />)
  })
}

afterEach(() => {
  cleanup()
  appInfo.platform = 'linux'
  localStorage.clear()
  useSettingsStore.setState(originalState, true)
  vi.clearAllMocks()
})

it('hides the Finder section when Quick Look is unavailable', async () => {
  await show({ state: 'unavailable', conflicts: [] })
  expect(screen.queryByRole('switch', { name: t('settings.quick_look') })).toBeNull()
})

it('turns the extensions off and shows the returned status', async () => {
  await show({ state: 'on', conflicts: [] })
  const toggle = screen.getByRole('switch', { name: t('settings.quick_look') })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  await act(async () => {
    fireEvent.click(toggle)
  })
  expect(invoke).toHaveBeenCalledWith('quickLook:set', { enabled: false })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

it('drops an older refresh that resolves after the toggle', async () => {
  await show({ state: 'on', conflicts: [] })
  let resolveRefresh: (status: QuickLookStatus) => void = () => {}
  invoke.mockImplementationOnce(() => new Promise((resolve) => (resolveRefresh = resolve)))
  act(() => {
    window.dispatchEvent(new Event('focus'))
  })
  const toggle = screen.getByRole('switch', { name: t('settings.quick_look') })
  await act(async () => {
    fireEvent.click(toggle)
  })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  await act(async () => {
    resolveRefresh({ state: 'on', conflicts: [] })
  })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

it('waits for a pending toggle before a focus refresh', async () => {
  await show({ state: 'on', conflicts: [] })
  // The backend state changes only when the toggle completes.
  let state: QuickLookStatus['state'] = 'on'
  let finishSet: () => void = () => {}
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'quickLook:status') return { state, conflicts: [] }
    if (channel === 'quickLook:set') {
      await new Promise<void>((resolve) => (finishSet = resolve))
      state = 'off'
      return { state, conflicts: [] }
    }
    return null
  })
  invoke.mockClear()
  const toggle = screen.getByRole('switch', { name: t('settings.quick_look') })
  await act(async () => {
    fireEvent.click(toggle)
    window.dispatchEvent(new Event('focus'))
  })
  expect(invoke).not.toHaveBeenCalledWith('quickLook:status')
  await act(async () => {
    finishSet()
  })
  expect(invoke).toHaveBeenCalledWith('quickLook:status')
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

it('warns about another app and turns off its extensions', async () => {
  const ids = ['com.example.peek.Thumbnail', 'com.example.peek.Preview']
  await show({ state: 'on', conflicts: [{ app: 'X3F Peek', ids }] })
  screen.getByText(t('settings.quick_look.conflict', { app: 'X3F Peek' }))
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: t('settings.quick_look.turn_off', { app: 'X3F Peek' }) })
    )
  })
  expect(invoke).toHaveBeenCalledWith('quickLook:set', { enabled: false, ids })
  expect(screen.queryByText(t('settings.quick_look.conflict', { app: 'X3F Peek' }))).toBeNull()
})
