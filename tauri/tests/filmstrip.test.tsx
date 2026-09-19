// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useQueueStore } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { FileFilmstrip } from '../src/renderer/src/components/FileFilmstrip'

vi.mock('../src/renderer/src/components/Thumbnail', () => ({
  Thumbnail: ({ file }: { file: { id: string } }) => <div data-cell={file.id} />
}))
vi.mock('../src/renderer/src/components/ZoomablePreview', () => ({
  ZoomablePreview: ({ file }: { file: { id: string } }) => <div data-active={file.id} />
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps a thousand-file strip bounded and scrolls to the keyboard cursor', async () => {
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
  expect(view.container.querySelector('[data-active="998"]')).toBeTruthy()
  fireEvent.keyDown(view.container.querySelector('[tabindex="0"]')!, { key: 'ArrowRight' })
  expect(useQueueStore.getState().activeId).toBe('999')
  expect(view.container.querySelectorAll('[data-cell]').length).toBeLessThan(16)
})
