import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { NativeMenuRequest } from '@shared/ipc'
import { registerNativeMenuHandlers } from '../src/main/ipc/nativeMenu'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  fromWebContents: vi.fn(),
  buildFromTemplate: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      mocks.handlers.set(channel, handler)
  },
  Menu: { buildFromTemplate: mocks.buildFromTemplate }
}))
let window: EventEmitter & { isDestroyed: () => boolean }
let sender: EventEmitter & { mainFrame: object; getZoomFactor: () => number }
let template: {
  label: string
  type: string
  checked?: boolean
  enabled: boolean
  click: () => void
}[]
let popup: { callback: () => void; x: number; y: number; window: unknown }
const closePopup = vi.fn()
const request: NativeMenuRequest = {
  id: 'format',
  x: 10.25,
  y: 40.5,
  items: [
    { value: 'dng', label: 'DNG', checked: true },
    { value: 'tiff', label: 'TIFF', checked: false },
    { value: 'unavailable', label: 'Unavailable', disabled: true }
  ]
}
const event = () => ({ sender, senderFrame: sender.mainFrame })
const show = (payload: unknown = request) => mocks.handlers.get('menu:popup')!(event(), payload)

beforeEach(() => {
  vi.clearAllMocks()
  window = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  sender = Object.assign(new EventEmitter(), { mainFrame: {}, getZoomFactor: () => 1.5 })
  mocks.fromWebContents.mockReturnValue(window)
  closePopup.mockImplementation(() => popup.callback())
  mocks.buildFromTemplate.mockImplementation((items) => {
    template = items
    return {
      popup: (options: typeof popup) => {
        popup = options
      },
      closePopup
    }
  })
  registerNativeMenuHandlers()
})

it('anchors to the requesting window at its zoom factor and returns a native selection', async () => {
  const result = show()
  expect(popup).toMatchObject({ window, x: 15, y: 61 })
  expect(template.map(({ type, checked, enabled }) => ({ type, checked, enabled }))).toEqual([
    { type: 'radio', checked: true, enabled: true },
    { type: 'radio', checked: false, enabled: true },
    { type: 'normal', checked: undefined, enabled: false }
  ])
  template[1].click()
  popup.callback()
  await expect(result).resolves.toBe('tiff')
  expect(window.listenerCount('resize')).toBe(0)
  expect(sender.listenerCount('did-start-navigation')).toBe(0)
})

it('returns null on native dismissal and ignores disabled selections', async () => {
  const result = show()
  template[2].click()
  popup.callback()
  await expect(result).resolves.toBeNull()
})

it('closes only the owning popup and releases it on window changes or navigation', async () => {
  let result = show()
  mocks.handlers.get('menu:close')!(event(), 'other-menu')
  expect(closePopup).not.toHaveBeenCalled()
  mocks.handlers.get('menu:close')!(event(), request.id)
  await expect(result).resolves.toBeNull()
  for (const [target, name] of [
    [window, 'resize'],
    [sender, 'did-start-navigation']
  ] as const) {
    result = show()
    target.emit(name)
    await expect(result).resolves.toBeNull()
  }
  result = show()
  window.isDestroyed = () => true
  window.emit('closed')
  await expect(result).resolves.toBeNull()
  expect(window.listenerCount('resize')).toBe(0)
})

it('cancels the prior menu when another opens and cleans up a failed popup', async () => {
  const first = show()
  const second = show({ ...request, id: 'scope' })
  await expect(first).resolves.toBeNull()
  popup.callback()
  await expect(second).resolves.toBeNull()
  mocks.buildFromTemplate.mockReturnValue({
    popup: () => {
      throw new Error('Cannot show')
    },
    closePopup
  })
  await expect(show()).rejects.toThrow('Cannot show')
  expect(window.listenerCount('resize')).toBe(0)
})

it('rejects malformed menu data and requests from non-window or child-frame senders', () => {
  for (const payload of [
    null,
    {},
    { ...request, x: NaN },
    { ...request, y: -1 },
    { ...request, items: [] },
    { ...request, items: [request.items[0], request.items[0]] },
    { ...request, items: [{ label: 'Bad', value: 'bad', checked: 'yes' }] }
  ]) {
    expect(() => show(payload)).toThrow('Invalid menu request')
  }
  expect(() => mocks.handlers.get('menu:popup')!({ sender, senderFrame: {} }, request)).toThrow(
    'Invalid menu sender'
  )
  mocks.fromWebContents.mockReturnValue(null)
  expect(() => show()).toThrow('Invalid menu sender')
  expect(mocks.buildFromTemplate).not.toHaveBeenCalled()
})
