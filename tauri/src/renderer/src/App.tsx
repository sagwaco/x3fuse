import { useEffect, useState } from 'react'
import { MainWindow } from './components/MainWindow'
import { SettingsWindow } from './components/SettingsWindow'
import { GlassFilters } from './components/ui/glassFilters'
import { applyTheme } from './lib/theme'
import { useSettingsStore } from './stores/settingsStore'

/**
 * Both windows load the same bundle; the Settings window is opened with a
 * `#settings` hash, which this routes on.
 */
export default function App(): React.JSX.Element {
  const [hash, setHash] = useState(() => window.location.hash)
  const appearanceMode = useSettingsStore((s) => s.settings.appearanceMode)
  const lightTheme = useSettingsStore((s) => s.settings.lightTheme)
  const darkTheme = useSettingsStore((s) => s.settings.darkTheme)

  useEffect(() => {
    const refresh = (): void => applyTheme(useSettingsStore.getState().settings)
    refresh()
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener('change', refresh)
    return () => media?.removeEventListener('change', refresh)
  }, [appearanceMode, lightTheme, darkTheme])

  useEffect(() => {
    const onHash = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <>
      <GlassFilters />
      {hash.startsWith('#settings') ? <SettingsWindow /> : <MainWindow />}
    </>
  )
}
