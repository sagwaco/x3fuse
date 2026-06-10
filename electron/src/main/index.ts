import { app, BrowserWindow } from 'electron'
import { createContext } from './context'
import { WindowManager } from './windows'
import { registerIpcHandlers } from './ipc/router'
import { buildAppMenu } from './menu'
import { createTranslator } from './i18n'
import { registerPreviewProtocol, registerPreviewScheme } from './previewProtocol'

// Must run before app is ready: marks x3f-preview:// secure/standard/CORS-enabled.
registerPreviewScheme()

app.whenReady().then(async () => {
  const ctx = createContext()
  // Mirror BinaryManager: ensure the embedded executables are runnable (unix).
  await ctx.resolver.ensurePermissions()

  // Serve embedded thumbnails/previews to the renderer over the custom scheme.
  registerPreviewProtocol(ctx.preview)

  const t = createTranslator()
  const windows = new WindowManager(ctx.sink)
  registerIpcHandlers(ctx, windows, t)

  buildAppMenu(
    {
      send: (name) => ctx.sink.emit('menu:command', { name }),
      openSettings: () => windows.openSettings(),
      openLogs: () => {
        void ctx.logs.openDir()
      },
      clearLogs: () => {
        void ctx.logs.clear()
      },
      checkForUpdates: () => {
        /* M4 */
      }
    },
    t
  )

  windows.createMain()

  app.on('activate', () => {
    // macOS: re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) windows.createMain()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
