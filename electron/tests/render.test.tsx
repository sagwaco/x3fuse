// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@shared/types'

/**
 * Renderer smoke test: mounts the real component tree (stores + IPC hook + Radix)
 * against a mocked `window.x3f` bridge to catch render-time throws that the dev
 * boot log can't surface. Set the bridge before any module that reads it at load.
 */
const invoke = vi.fn(async (channel: string) => {
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

afterEach(() => cleanup())

describe('renderer smoke', () => {
  it('mounts MainWindow with the empty drop zone', async () => {
    const { MainWindow } = await import('../src/renderer/src/components/MainWindow')
    render(<MainWindow />)
    expect(screen.getByText('No files in queue')).toBeTruthy()
    expect(screen.getByText('Convert')).toBeTruthy()
  })

  it('mounts the Settings window with its sections', async () => {
    const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
    // Settings window gates on `loaded`; prime it so sections render synchronously.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })

    const { SettingsWindow } = await import('../src/renderer/src/components/SettingsWindow')
    render(<SettingsWindow />)
    expect(screen.getByText('Output settings')).toBeTruthy()
    expect(screen.getByText('Conversion settings')).toBeTruthy()
  })
})
