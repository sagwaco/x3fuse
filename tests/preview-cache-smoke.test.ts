// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { X3FFileDTO } from '@shared/types'
import { displayPreviewUrl, previewUrl } from '@shared/preview'

const mocks = vi.hoisted(() => ({
  files: [] as X3FFileDTO[],
  addFiles: vi.fn(),
  small: vi.fn(),
  painted: vi.fn()
}))
vi.mock('../src/renderer/src/stores/queueStore', () => ({
  useQueueStore: {
    getState: () => ({ files: mocks.files, addFiles: mocks.addFiles, clearQueue: () => {} })
  }
}))
vi.mock('../src/renderer/src/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ load: async () => {}, update: async () => {}, settings: {} })
  }
}))
vi.mock('../src/renderer/src/stores/navStore', () => ({
  useNavStore: { getState: () => ({ goToQueue: () => {} }) }
}))
vi.mock('../src/renderer/src/lib/nativeSmoke', () => ({ painted: mocks.painted }))
vi.mock('../src/renderer/src/lib/previewImages', () => ({ loadSmallPreview: mocks.small }))
vi.mock('../src/renderer/src/lib/fitPreviews', () => ({
  subscribeFitPreview: (_url: string, ready: () => void) => {
    ready()
    return () => {}
  }
}))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke: async () => 0 } }))

import { runPreviewCacheSmoke } from '../src/renderer/src/lib/previewCacheSmoke'

afterEach(() => {
  document.body.replaceChildren()
  delete (document.body as Partial<HTMLElement>).innerText
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([
  { finishEdit: false, failOriginal: false },
  { finishEdit: true, failOriginal: false },
  { finishEdit: false, failOriginal: true }
])(
  'counts only painted pixels and separates edited paint (%j)',
  async ({ finishEdit, failOriginal }) => {
    vi.useFakeTimers()
    document.body.innerText = ''
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    mocks.files = []
    const file = {
      id: 'a',
      path: '/a.X3F',
      fileName: 'a.X3F',
      edit: { previewUrl: 'x3f-edit://localhost/saved', revision: 1 }
    } as X3FFileDTO
    let observe: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      observe = callback
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const cell = document.createElement('div')
    cell.title = file.fileName
    cell.dataset.fileId = file.id
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 100,
      top: 0,
      bottom: 100
    } as DOMRect)
    const canvas = document.createElement('canvas')
    canvas.setAttribute('role', 'img')
    canvas.dataset.previewUrl = previewUrl(file.path, 'preview', file.id)
    canvas.style.opacity = '1'
    if (failOriginal) {
      delete canvas.dataset.previewUrl
      canvas.style.display = 'none'
    }
    cell.append(canvas)
    document.body.append(cell)
    // The same filename outside this queue must not count as an edited hit.
    const other = cell.cloneNode(true) as HTMLElement
    other.dataset.fileId = 'other-photo'
    other.querySelector('canvas')!.dataset.previewUrl = displayPreviewUrl(file)
    vi.spyOn(other, 'getBoundingClientRect').mockImplementation(() => cell.getBoundingClientRect())
    document.body.append(other)
    mocks.painted.mockImplementation(async () => {
      observe(performance.now())
    })
    mocks.addFiles.mockImplementation(async () => {
      mocks.files = [file]
      vi.advanceTimersByTime(5)
      observe(performance.now())
    })
    mocks.small.mockImplementation(async () => {
      if (!finishEdit) return
      canvas.dataset.previewUrl = displayPreviewUrl(file)
      canvas.style.opacity = '0.5'
      vi.advanceTimersByTime(5)
      observe(performance.now())
      canvas.style.opacity = '1'
      vi.advanceTimersByTime(10)
      observe(performance.now())
    })
    const pending = runPreviewCacheSmoke([file.path], true)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.firstThumbnailMs).toBe(failOriginal ? undefined : 5)
    expect(result.firstGridMs).toBe(failOriginal ? undefined : 5)
    expect(result.ok).toBe(!failOriginal)
    expect(result.firstEditedThumbnailMs).toBe(finishEdit ? 20 : undefined)
    expect(result.firstEditedGridMs).toBe(finishEdit ? 20 : undefined)
  }
)
