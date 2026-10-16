import { beforeEach, expect, it, vi } from 'vitest'
import { IPC_EVENT_CHANNELS } from '@shared/ipc'

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  createMenu: vi.fn(),
  convert: vi.fn()
}))
vi.unmock('../src/renderer/src/lib/ipc')
vi.unmock('../src/renderer/src/lib/nativeMenu')
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, convertFileSrc: native.convert }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))
vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: native.createMenu } }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
})

it('maps typed domain requests to Rust commands and preserves payloads', async () => {
  const { ipc } = await import('../src/renderer/src/lib/ipc')
  const payload = { paths: ['/photos/한글 image.X3F'] }
  native.invoke.mockResolvedValue([])
  await ipc.invoke('queue:add', payload)
  expect(native.invoke).toHaveBeenCalledWith('queue_add', { payload })
  await ipc.invoke('dialog:pickOutputDir')
  expect(native.invoke).toHaveBeenLastCalledWith('dialog_pick_output_dir', {})
  await ipc.invoke('window:openSettings')
  expect(native.invoke).toHaveBeenLastCalledWith('window_open_settings', {})
})

it('waits for every native event listener before ready, shares initialization, and unsubscribes synchronously', async () => {
  const registrations: Array<{
    handler: (event: { payload: unknown }) => void
    finish: (off: () => void) => void
  }> = []
  native.listen.mockImplementation(
    (_channel, handler) => new Promise((finish) => registrations.push({ handler, finish }))
  )
  const { ipc, initializeIpc } = await import('../src/renderer/src/lib/ipc')
  let ready = false
  const first = initializeIpc()
  expect(initializeIpc()).toBe(first)
  void first.then(() => {
    ready = true
  })
  const listener = vi.fn()
  const off = ipc.on('batch:started', listener)
  registrations.slice(0, -1).forEach(({ finish }) => finish(vi.fn()))
  await Promise.resolve()
  expect(ready).toBe(false)
  registrations.at(-1)!.finish(vi.fn())
  await first
  expect(native.listen).toHaveBeenCalledTimes(IPC_EVENT_CHANNELS.length)
  const payload = { batchId: 'accepted', settings: {} }
  registrations[IPC_EVENT_CHANNELS.indexOf('batch:started')].handler({ payload })
  expect(listener).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledWith(payload)
  off()
  registrations[IPC_EVENT_CHANNELS.indexOf('batch:started')].handler({ payload })
  expect(listener).toHaveBeenCalledOnce()
})

it('cleans up even late subscriptions after a registration failure and permits retry', async () => {
  const off = vi.fn()
  let finish!: (off: () => void) => void
  native.listen.mockResolvedValue(off)
  native.listen.mockRejectedValueOnce(new Error('registration failed'))
  native.listen.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { initializeIpc } = await import('../src/renderer/src/lib/ipc')
  const check = expect(initializeIpc()).rejects.toThrow('registration failed')
  finish(off)
  await check
  expect(off).toHaveBeenCalledTimes(IPC_EVENT_CHANNELS.length - 1)
  await initializeIpc()
  expect(native.listen).toHaveBeenCalledTimes(IPC_EVENT_CHANNELS.length * 2)
})

it('uses native menu actions once, including callbacks queued after popup completion, and invalidates stale actions', async () => {
  const menus: Array<{
    items: Array<{ action: () => void; enabled: boolean }>
    close: ReturnType<typeof vi.fn>
    dismiss: () => void
  }> = []
  native.createMenu.mockImplementation(async ({ items }) => {
    let dismiss!: () => void
    const popup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          dismiss = resolve
        })
    )
    const close = vi.fn(async () => {})
    const menu = { items, close, dismiss: () => dismiss() }
    menus.push(menu)
    return { popup, close }
  })
  const { showNativeMenu, invalidateNativeMenu } =
    await import('../src/renderer/src/lib/nativeMenu')
  const onSelect = vi.fn()
  const request = {
    id: 'format',
    x: 20,
    y: 64,
    items: [
      { value: 'a', label: 'A', checked: true },
      { value: 'b', label: 'B', disabled: true, separatorBefore: true }
    ]
  }
  const first = showNativeMenu(request, onSelect)
  await Promise.resolve()
  expect(menus[0].items[1]).toEqual({ item: 'Separator' })
  menus[0].items[2].action()
  expect(onSelect).not.toHaveBeenCalled()
  menus[0].dismiss()
  await first
  menus[0].items[0].action()
  menus[0].items[0].action()
  expect(onSelect).toHaveBeenCalledOnce()
  expect(onSelect).toHaveBeenCalledWith('a')
  expect(menus[0].close).toHaveBeenCalledOnce()
  const second = showNativeMenu(request, onSelect)
  await Promise.resolve()
  invalidateNativeMenu(request.id)
  menus[1].items[0].action()
  expect(onSelect).toHaveBeenCalledOnce()
  expect(menus[1].close).not.toHaveBeenCalled()
  menus[1].dismiss()
  await second
})

it('lets Tauri encode the original source path once and preserves preview revisions', async () => {
  const path = 'C:\\photos\\space # 한글.X3F'
  native.convert.mockImplementation(
    (source: string, scheme: string) => `http://${scheme}.localhost/${encodeURIComponent(source)}`
  )
  const { previewUrl } = await import('../src/shared/preview')
  const url = new URL(previewUrl(path, 'full', 'import 2'))
  expect(native.convert).toHaveBeenCalledWith(path, 'x3f-preview')
  expect(decodeURIComponent(url.pathname.slice(1))).toBe(path)
  expect(url.searchParams.get('v')).toBe('full')
  expect(url.searchParams.get('r')).toBe('import 2')
})
