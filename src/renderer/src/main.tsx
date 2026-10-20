import React from 'react'
import ReactDOM from 'react-dom/client'
import { applyLanguage } from './i18n/config'
import App from './App'
import './index.css'
import { initializeIpc, ipc } from './lib/ipc'
import { appInfo } from './lib/appInfo'
import { applyTheme } from './lib/theme'
import { suppressDefaultMenu } from './lib/nativeMenu'
import { useSettingsStore } from './stores/settingsStore'

// On the window, so it runs after the React handlers that show their own menus.
window.addEventListener('contextmenu', suppressDefaultMenu)

async function start(): Promise<void> {
  const [, info] = await Promise.all([initializeIpc(), ipc.invoke('app:info')])
  await useSettingsStore.getState().load()
  applyTheme(useSettingsStore.getState().settings)
  await applyLanguage(useSettingsStore.getState().settings.language)
  Object.assign(appInfo, info)
  document.documentElement.dataset.platform = info.platform
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
  if (import.meta.env.VITE_NATIVE_SMOKE === '1') {
    const { installNativeSmoke } = await import('./lib/nativeSmoke')
    installNativeSmoke()
  }
}

void start().catch((error: unknown) => {
  console.error('Could not start X3Fuse', error)
  document.getElementById('root')!.textContent = `Could not start X3Fuse: ${String(error)}`
})
