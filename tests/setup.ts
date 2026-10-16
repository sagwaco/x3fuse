import { vi } from 'vitest'

type TestBridge = {
  invoke: (...args: unknown[]) => Promise<unknown>
  on: (...args: unknown[]) => () => void
}
const bridge = (): TestBridge => (window as unknown as { x3f: TestBridge }).x3f

// Keep the inherited UI scenarios' fake command bridge; production has no window bridge.
vi.mock('../src/renderer/src/lib/ipc', () => ({
  ipc: {
    invoke: (...args: unknown[]) => bridge().invoke(...args),
    on: (...args: unknown[]) => bridge().on(...args)
  }
}))

vi.mock('../src/renderer/src/lib/nativeMenu', async () => {
  const { ipc } = await import('../src/renderer/src/lib/ipc')
  const call = ipc.invoke as (channel: string, payload: unknown) => Promise<string | null>
  let active: { id: string; valid: boolean } | undefined
  return {
    showNativeMenu: (request: { id: string }, onSelect: (value: string) => void) => {
      if (active) active.valid = false
      const token = { id: request.id, valid: true }
      active = token
      return call('menu:popup', request).then((value) => {
        if (value !== null && value !== undefined && token.valid) {
          token.valid = false
          onSelect(value)
        }
      })
    },
    invalidateNativeMenu: (id: string) => {
      if (active?.id === id && active.valid) {
        active.valid = false
        void call('menu:close', id)
      }
    }
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string, scheme: string) =>
    `${scheme}://localhost/${encodeURIComponent(path)}`
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} })
}))
