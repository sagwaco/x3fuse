// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { applyTheme, resolveTheme } from '../src/renderer/src/lib/theme'

const { setTheme, setBackgroundColor } = vi.hoisted(() => ({
  setTheme: vi.fn().mockResolvedValue(undefined),
  setBackgroundColor: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTheme, setBackgroundColor })
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  delete document.documentElement.dataset.theme
})

describe('resolveTheme', () => {
  it('uses the dark theme for auto with a dark system appearance', () => {
    expect(resolveTheme({ ...DEFAULT_SETTINGS, darkTheme: 'gray' }, true)).toBe('gray')
  })

  it('uses the light theme for auto with a light system appearance', () => {
    expect(resolveTheme({ ...DEFAULT_SETTINGS, lightTheme: 'gray' }, false)).toBe('gray')
  })

  it('uses the light theme when light appearance is pinned', () => {
    expect(resolveTheme({ ...DEFAULT_SETTINGS, appearanceMode: 'light' }, true)).toBe('light')
  })

  it('uses the dark theme when dark appearance is pinned', () => {
    expect(resolveTheme({ ...DEFAULT_SETTINGS, appearanceMode: 'dark' }, false)).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('follows the system with a dark fallback when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    applyTheme(DEFAULT_SETTINGS)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(setTheme).toHaveBeenCalledWith(null)
    expect(setBackgroundColor).toHaveBeenCalledWith([10, 10, 10])
  })

  it('sets the native appearance and the chosen theme surface independently', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    applyTheme({ ...DEFAULT_SETTINGS, appearanceMode: 'light', lightTheme: 'gray' })
    expect(document.documentElement.dataset.theme).toBe('gray')
    expect(setTheme).toHaveBeenCalledWith('light')
    expect(setBackgroundColor).toHaveBeenCalledWith([119, 119, 119])
  })
})
