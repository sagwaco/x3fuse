// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'
import { defaultRecipe } from '@shared/editor'
import { displayPreviewUrl } from '@shared/preview'
import { useQueueStore } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { useEditorStore } from '../src/renderer/src/stores/editorStore'
import { FileFilmstrip } from '../src/renderer/src/components/FileFilmstrip'
import { ipc } from '../src/renderer/src/lib/ipc'
import { DevelopingCloud } from '../src/renderer/src/lib/developingCloud'

vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke: vi.fn(async () => null) } }))

vi.mock('../src/renderer/src/components/Thumbnail', () => ({
  Thumbnail: ({ file }: { file: X3FFileDTO }) => (
    <div data-cell={file.id} data-url={displayPreviewUrl(file)} />
  )
}))
vi.mock('../src/renderer/src/components/ZoomablePreview', () => ({
  ZoomablePreview: ({ file, nativePreview }: { file: { id: string }; nativePreview?: boolean }) => (
    <div data-active={file.id} data-native-preview={nativePreview} />
  )
}))
afterEach(() => {
  cleanup()
  useEditorStore.setState({ session: null, preview: null })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reuses the active editor frame for its thumbnail while preserving saved URLs and other photos', async () => {
  const files: X3FFileDTO[] = ['a', 'b'].map((id) => ({
    id,
    path: `/photos/${id}.X3F`,
    fileName: `${id}.X3F`,
    edit: { recipe: defaultRecipe(), revision: 1, previewUrl: `saved-${id}-2048` }
  }))
  useQueueStore.setState({ files, activeId: 'a', selectedIds: new Set(['a']) })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
  useEditorStore.setState({
    session: { sessionId: 'editor-a', path: files[0].path, recipe: defaultRecipe(), revision: 1 },
    preview: {
      sessionId: 'editor-a',
      revision: 1,
      url: 'interactive-a-512',
      width: 512,
      height: 341
    }
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(420)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(104)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(420)
  HTMLElement.prototype.scrollTo = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  // The strip loads the editor's pixels after the developing cloud leaves.
  const view = render(
    <DevelopingCloud.Provider value>
      <FileFilmstrip preview={<div />} />
    </DevelopingCloud.Provider>
  )
  const url = (id: string): string | null | undefined =>
    view.container.querySelector(`[data-cell="${id}"]`)?.getAttribute('data-url')
  await waitFor(() => expect(url('a')).toBe('saved-a-2048'))
  view.rerender(
    <DevelopingCloud.Provider value={false}>
      <FileFilmstrip preview={<div />} />
    </DevelopingCloud.Provider>
  )
  await waitFor(() => expect(url('a')).toBe('interactive-a-512'))
  expect(url('b')).toBe('saved-b-2048')
  act(() =>
    useQueueStore.setState({
      files: [
        { ...files[0], edit: { ...files[0].edit!, revision: 2, previewUrl: 'saved-a-new-2048' } },
        files[1]
      ]
    })
  )
  expect(url('a')).toBe('interactive-a-512')
  expect(useQueueStore.getState().files[0].edit?.previewUrl).toBe('saved-a-new-2048')
  act(() =>
    useEditorStore.setState({
      preview: { ...useEditorStore.getState().preview!, revision: 2, url: 'interactive-a-new-512' }
    })
  )
  expect(url('a')).toBe('interactive-a-new-512')
  act(() => useQueueStore.setState({ activeId: 'b', selectedIds: new Set(['b']) }))
  expect(url('b')).toBe('saved-b-2048')
  expect(url('a')).toBe('saved-a-new-2048')
  act(() => useQueueStore.setState({ activeId: 'a', selectedIds: new Set(['a']) }))
  view.rerender(<FileFilmstrip />)
  expect(url('a')).toBe('saved-a-new-2048')
})

it('keeps a thousand-file strip bounded, follows the cursor, and preserves preview context selection', async () => {
  const files = Array.from({ length: 1000 }, (_, i) => ({
    id: String(i),
    path: `/photos/${i}.X3F`,
    fileName: `${String(i).padStart(4, '0')}.X3F`
  }))
  useQueueStore.setState({ files, activeId: '0', selectedIds: new Set(['0']) })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(420)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(104)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(420)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(84016)
  HTMLElement.prototype.scrollTo = function (options: ScrollToOptions | number) {
    if (typeof options === 'object') this.scrollLeft = options.left ?? 0
    queueMicrotask(() => this.dispatchEvent(new Event('scroll')))
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  const view = render(<FileFilmstrip />)
  await waitFor(() =>
    expect(view.container.querySelectorAll('[data-cell]').length).toBeGreaterThan(0)
  )
  expect(view.container.querySelectorAll('[data-cell]').length).toBeLessThan(16)
  const strip = view.container.querySelector('[data-filmstrip]')!
  act(() => useQueueStore.getState().setSelection(new Set(['998']), '998'))
  await waitFor(() => expect(strip.scrollLeft).toBeGreaterThan(80000))
  expect(
    view.container.querySelector('[data-active="998"]')!.getAttribute('data-native-preview')
  ).toBe('true')
  act(() => useQueueStore.getState().setSelection(new Set(['997', '998']), '998'))
  await act(async () => {
    fireEvent.contextMenu(view.container.querySelector('[data-active="998"]')!)
  })
  expect(useQueueStore.getState().activeId).toBe('998')
  expect(useQueueStore.getState().selectedIds).toEqual(new Set(['997', '998']))
  expect(view.container.querySelector('[data-active="998"]')).toBeTruthy()
  expect(ipc.invoke).toHaveBeenCalledWith(
    'menu:popup',
    expect.objectContaining({
      items: expect.arrayContaining([expect.objectContaining({ value: 'reveal' })])
    })
  )
  act(() => (document.activeElement as HTMLElement).blur())
  fireEvent.keyDown(document.body, { key: 'ArrowRight' })
  expect(useQueueStore.getState().activeId).toBe('999')
  expect(view.container.querySelectorAll('[data-cell]').length).toBeLessThan(16)
})

it('selects the photo that it shows when nothing is selected', async () => {
  const files: X3FFileDTO[] = ['a', 'b'].map((id) => ({
    id,
    path: `/photos/${id}.X3F`,
    fileName: `${id}.X3F`
  }))
  useQueueStore.setState({ files, activeId: null, selectedIds: new Set() })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  render(<FileFilmstrip />)
  await waitFor(() => expect(useQueueStore.getState().selectedIds).toEqual(new Set(['a'])))
  expect(useQueueStore.getState().activeId).toBe('a')
})
