import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import type { WebContentsSink } from './ipc/WebContentsSink'

const PRELOAD = join(__dirname, '../preload/index.js')
const RENDERER_HTML = join(__dirname, '../renderer/index.html')

const commonWebPreferences = {
  preload: PRELOAD,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false
} as const

/**
 * Owns the application's windows: a single main window (the conversion queue)
 * and an on-demand Settings window. Both load the same renderer bundle; the
 * Settings window is distinguished by a `#settings` hash that App.tsx routes on.
 */
export class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private settingsWindow: BrowserWindow | null = null

  constructor(private readonly sink: WebContentsSink) {}

  getMain(): BrowserWindow | null {
    return this.mainWindow
  }

  createMain(): BrowserWindow {
    const win = new BrowserWindow({
      width: 960,
      height: 680,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: 'X3Fuse',
      backgroundColor: '#0a0a0a',
      webPreferences: commonWebPreferences
    })

    win.on('ready-to-show', () => win.show())
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })
    win.on('closed', () => {
      this.sink.detach(win.webContents)
      this.mainWindow = null
    })

    this.load(win)
    this.sink.attach(win.webContents)
    this.mainWindow = win
    return win
  }

  openSettings(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.focus()
      return
    }

    const win = new BrowserWindow({
      width: 540,
      height: 640,
      minWidth: 460,
      minHeight: 420,
      show: false,
      title: 'Settings',
      backgroundColor: '#0a0a0a',
      parent: this.mainWindow ?? undefined,
      webPreferences: commonWebPreferences
    })

    win.on('ready-to-show', () => win.show())
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })
    win.on('closed', () => {
      this.settingsWindow = null
    })

    this.load(win, 'settings')
    this.settingsWindow = win
  }

  private load(win: BrowserWindow, hash?: string): void {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      win.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
    } else {
      win.loadFile(RENDERER_HTML, hash ? { hash } : undefined)
    }
  }
}
