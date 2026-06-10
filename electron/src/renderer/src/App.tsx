import { useEffect, useState } from 'react'
import { MainWindow } from './components/MainWindow'
import { SettingsWindow } from './components/SettingsWindow'

/**
 * Both windows load the same bundle; the Settings window is opened with a
 * `#settings` hash (see main/windows.ts), which this routes on.
 */
export default function App(): React.JSX.Element {
  const [hash, setHash] = useState(() => window.location.hash)

  useEffect(() => {
    const onHash = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return hash.startsWith('#settings') ? <SettingsWindow /> : <MainWindow />
}
