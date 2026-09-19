import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n/config'
import App from './App'
import './index.css'
import { initializeIpc, ipc } from './lib/ipc'
import { appInfo } from './lib/appInfo'

async function start(): Promise<void> {
  const [, info] = await Promise.all([initializeIpc(), ipc.invoke('app:info')])
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
