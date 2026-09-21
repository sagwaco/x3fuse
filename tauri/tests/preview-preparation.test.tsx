// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { defaultRecipe } from '@shared/editor'
import { previewUrl } from '@shared/preview'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'
import { PreviewPreparation } from '../src/renderer/src/components/MainWindow'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { useNavStore as nav } from '../src/renderer/src/stores/navStore'

const { prefetch } = vi.hoisted(() => ({ prefetch: vi.fn() }))
vi.mock('../src/renderer/src/lib/fitPreviews', () => ({ prefetchFitPreviews: prefetch }))

const files: X3FFileDTO[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({
  id,
  path: `/photos/${id}.X3F`,
  fileName: `${id}.X3F`,
  pending: id === 'e',
  ...(id === 'c' || id === 'f'
    ? {
        edit: {
          recipe: defaultRecipe(),
          revision: 1,
          previewUrl: id === 'c' ? 'x3f-edit://localhost/saved-c' : undefined
        }
      }
    : {})
}))
const source = (id: string): string =>
  id === 'c' ? 'x3f-edit://localhost/saved-c' : previewUrl(`/photos/${id}.X3F`, 'full', id)
let stops: Array<ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.useFakeTimers()
  stops = []
  prefetch.mockReset().mockImplementation(() => {
    const stop = vi.fn()
    stops.push(stop)
    return stop
  })
  queue.setState({ files, activeId: 'c', isPreparing: false, isProcessing: false })
  editor.setState({
    closing: false,
    loading: false,
    rendering: false,
    session: null,
    documents: {}
  })
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, sortField: 'File Name', sortAscending: true }
  })
  nav.setState({ screen: 'queue' })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('warms saved edits and embedded previews in selection order without cancelling useful work on navigation', async () => {
  const view = render(<PreviewPreparation />)
  await act(() => vi.advanceTimersByTimeAsync(149))
  expect(prefetch).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(prefetch).toHaveBeenLastCalledWith(['c', 'd', 'b', 'g', 'a'].map(source))
  act(() => queue.setState({ activeId: 'g' }))
  await act(() => vi.advanceTimersByTimeAsync(100))
  act(() => queue.setState({ activeId: 'b' }))
  await act(() => vi.advanceTimersByTimeAsync(149))
  expect(prefetch).toHaveBeenCalledTimes(1)
  expect(stops[0]).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(prefetch).toHaveBeenCalledTimes(2)
  expect(prefetch).toHaveBeenLastCalledWith(['b', 'c', 'a', 'd', 'g'].map(source))
  expect(stops[0]).not.toHaveBeenCalled()
  view.unmount()
  expect(stops[1]).toHaveBeenCalledOnce()
})

it('pauses during export work and foreground editor rendering, then resumes idle preparation', async () => {
  render(<PreviewPreparation />)
  await act(() => vi.advanceTimersByTimeAsync(150))
  act(() => {
    nav.setState({ screen: 'export' })
    queue.setState({ isPreparing: true })
  })
  expect(stops[0]).toHaveBeenCalledOnce()
  await act(() => vi.advanceTimersByTimeAsync(500))
  act(() => queue.setState({ isPreparing: false, isProcessing: true }))
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(prefetch).toHaveBeenCalledTimes(1)
  act(() => {
    queue.setState({ isProcessing: false })
    nav.setState({ screen: 'editor' })
    editor.setState({ rendering: true })
  })
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(prefetch).toHaveBeenCalledTimes(1)
  act(() => editor.setState({ rendering: false }))
  await act(() => vi.advanceTimersByTimeAsync(150))
  expect(prefetch).toHaveBeenCalledTimes(2)
  act(() => editor.setState({ rendering: true }))
  expect(stops[1]).toHaveBeenCalledOnce()
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(prefetch).toHaveBeenCalledTimes(2)
  act(() => editor.setState({ rendering: false }))
  await act(() => vi.advanceTimersByTimeAsync(150))
  expect(prefetch).toHaveBeenCalledTimes(3)
  expect(prefetch).toHaveBeenLastCalledWith(['c', 'd', 'b', 'g', 'a'].map(source))
  act(() => {
    nav.setState({ screen: 'queue' })
    editor.setState({ closing: true })
  })
  expect(stops[2]).toHaveBeenCalledOnce()
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(prefetch).toHaveBeenCalledTimes(3)
})
