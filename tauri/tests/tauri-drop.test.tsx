// @vitest-environment jsdom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFileDrop } from '../src/renderer/src/hooks/useFileDrop'

const native = vi.hoisted(() => ({ subscribe: vi.fn(), addFiles: vi.fn(), draft: null as unknown }))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: native.subscribe })
}))
vi.mock('../src/renderer/src/stores/queueStore', () => ({
  useQueueStore: { getState: () => ({ draft: native.draft, addFiles: native.addFiles }) }
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  native.draft = null
})

it('imports a native drop once, filters extensions, and ignores export drafts', async () => {
  let handler!: (event: { payload: { type: string; paths?: string[] } }) => void
  const off = vi.fn()
  native.subscribe.mockImplementation(async (callback) => {
    handler = callback
    return off
  })
  const view = renderHook(() => useFileDrop())
  await act(async () => {})
  act(() => handler({ payload: { type: 'over' } }))
  expect(view.result.current.isDragOver).toBe(true)
  act(() =>
    handler({ payload: { type: 'drop', paths: ['C:\\A.X3F', '/photos/b.x3f', '/photos/a.jpg'] } })
  )
  expect(native.addFiles).toHaveBeenCalledOnce()
  expect(native.addFiles).toHaveBeenCalledWith(['C:\\A.X3F', '/photos/b.x3f'])
  expect(view.result.current.isDragOver).toBe(false)
  native.draft = { files: [] }
  act(() => handler({ payload: { type: 'drop', paths: ['/photos/c.X3F'] } }))
  expect(native.addFiles).toHaveBeenCalledOnce()
  view.unmount()
  expect(off).toHaveBeenCalledOnce()
})

it('unsubscribes when a native registration resolves after unmount', async () => {
  let finish!: (off: () => void) => void
  native.subscribe.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const view = renderHook(() => useFileDrop())
  view.unmount()
  const off = vi.fn()
  await act(async () => finish(off))
  expect(off).toHaveBeenCalledOnce()
})
