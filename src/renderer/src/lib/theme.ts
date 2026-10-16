import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ConversionSettings, ThemeName } from '@shared/types'

export const THEME_SURFACE: Record<ThemeName, [number, number, number]> = {
  dark: [10, 10, 10],
  light: [250, 250, 250],
  gray: [119, 119, 119]
}

export function resolveTheme(
  settings: Pick<ConversionSettings, 'appearanceMode' | 'lightTheme' | 'darkTheme'>,
  systemDark: boolean
): ThemeName {
  const dark = settings.appearanceMode === 'auto' ? systemDark : settings.appearanceMode === 'dark'
  return dark ? settings.darkTheme : settings.lightTheme
}

export function applyTheme(settings: ConversionSettings): void {
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  const theme = resolveTheme(settings, systemDark)
  document.documentElement.dataset.theme = theme
  const win = getCurrentWindow()
  void win
    .setTheme(settings.appearanceMode === 'auto' ? null : settings.appearanceMode)
    .catch((error: unknown) => console.error('Could not set window appearance', error))
  void win
    .setBackgroundColor(THEME_SURFACE[theme])
    .catch((error: unknown) => console.error('Could not set window background', error))
}
