import { BrowserWindow, ipcMain, Menu, type WebContents } from 'electron'
import type { NativeMenuRequest } from '@shared/ipc'

/** Only data crosses IPC; native menu callbacks stay in the main process. */
export function registerNativeMenuHandlers(): void {
  const active = new Map<WebContents, { id: string; close: () => void }>()

  ipcMain.handle('menu:popup', (event, request: NativeMenuRequest) => {
    const sender = event.sender
    const window = BrowserWindow.fromWebContents(sender)
    if (!window || event.senderFrame !== sender.mainFrame) throw new Error('Invalid menu sender')
    if (
      !request ||
      typeof request.id !== 'string' ||
      request.id.length > 128 ||
      !Number.isFinite(request.x) ||
      !Number.isFinite(request.y) ||
      request.x < 0 ||
      request.y < 0 ||
      request.x > 100000 ||
      request.y > 100000 ||
      !Array.isArray(request.items) ||
      request.items.length === 0 ||
      request.items.length > 100 ||
      request.items.some(
        (item) =>
          !item ||
          typeof item.value !== 'string' ||
          item.value.length > 128 ||
          typeof item.label !== 'string' ||
          item.label.length > 500 ||
          (item.disabled !== undefined && typeof item.disabled !== 'boolean') ||
          (item.checked !== undefined && typeof item.checked !== 'boolean')
      ) ||
      new Set(request.items.map((item) => item.value)).size !== request.items.length
    )
      throw new Error('Invalid menu request')

    active.get(sender)?.close()
    return new Promise<string | null>((resolve, reject) => {
      let finished = false
      const finish = (value: string | null): void => {
        if (finished) return
        finished = true
        active.delete(sender)
        window.removeListener('resize', close)
        window.removeListener('closed', close)
        sender.removeListener('did-start-navigation', close)
        resolve(value)
      }
      const menu = Menu.buildFromTemplate(
        request.items.map((item) => ({
          label: item.label,
          type: item.checked === undefined ? 'normal' : 'radio',
          checked: item.checked,
          enabled: !item.disabled,
          click: () => {
            if (!item.disabled) finish(item.value)
          }
        }))
      )
      const close = (): void => {
        if (!window.isDestroyed()) menu.closePopup(window)
        finish(null)
      }
      active.set(sender, { id: request.id, close })
      window.once('resize', close)
      window.once('closed', close)
      sender.once('did-start-navigation', close)
      try {
        const zoom = sender.getZoomFactor()
        menu.popup({
          window,
          x: Math.round(request.x * zoom),
          y: Math.round(request.y * zoom),
          callback: () => finish(null)
        })
      } catch (error) {
        // Release listeners even if Electron cannot show the popup.
        reject(error)
        finish(null)
      }
    })
  })

  ipcMain.handle('menu:close', (event, id: string) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    const popup = active.get(event.sender)
    if (popup?.id === id) popup.close()
  })
}
