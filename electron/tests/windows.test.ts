import { afterEach, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { WindowManager } from '../src/main/windows'
import { WebContentsSink } from '../src/main/ipc/WebContentsSink'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    BrowserWindow: vi.fn(() =>
      Object.assign(new EventEmitter(), {
        loadURL: vi.fn(),
        loadFile: vi.fn(),
        webContents: { setWindowOpenHandler: vi.fn() }
      })
    ),
    shell: { openExternal: vi.fn() }
  }
})

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.clearAllMocks()
})

it('detaches a closed window without accessing its destroyed native object', () => {
  const sink = new WebContentsSink()
  const detach = vi.spyOn(sink, 'detach')
  const windows = new WindowManager(sink)
  const win = windows.createMain()
  const webContents = win.webContents
  Object.defineProperty(win, 'webContents', {
    get() {
      throw new Error('Object has been destroyed')
    }
  })

  expect(() => win.emit('closed')).not.toThrow()
  expect(detach).toHaveBeenCalledWith(webContents)
  expect(windows.getMain()).toBeNull()
})

it.each(['darwin', 'win32', 'linux'])(
  'only integrates traffic lights into the macOS main window (%s)',
  (platform) => {
    Object.defineProperty(process, 'platform', { value: platform })
    const windows = new WindowManager(new WebContentsSink())
    windows.createMain()
    windows.openSettings()

    const [mainOptions, settingsOptions] = vi
      .mocked(BrowserWindow)
      .mock.calls.map(([options]) => options)
    if (platform === 'darwin') {
      expect(mainOptions).toHaveProperty('titleBarStyle', 'hidden')
    } else {
      expect(mainOptions).not.toHaveProperty('titleBarStyle')
      expect(mainOptions).not.toHaveProperty('trafficLightPosition')
    }
    expect(mainOptions).not.toHaveProperty('frame', false)
    expect(settingsOptions).not.toHaveProperty('titleBarStyle')
    expect(settingsOptions).not.toHaveProperty('trafficLightPosition')
    expect(settingsOptions).not.toHaveProperty('frame', false)
  }
)
