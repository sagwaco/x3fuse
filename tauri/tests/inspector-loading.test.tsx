// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS, type ExifPair, type X3FFileDTO } from '@shared/types'
import { Inspector } from '../src/renderer/src/components/Inspector'
import { useExif, useSelectionExif } from '../src/renderer/src/hooks/useExif'
import { useQueueStore } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))
vi.mock('../src/renderer/src/components/PreviewMinimap', () => ({
  PreviewMinimap: ({ file }: { file: X3FFileDTO }) => <img alt={file.fileName} />
}))
vi.mock('../src/renderer/src/components/OrientedImage', () => ({
  OrientedImage: ({ file }: { file: X3FFileDTO }) => <img alt={file.fileName} />
}))
vi.mock('../src/renderer/src/components/ColorScope', () => ({
  ColorScope: () => <div data-testid="scope" />
}))
vi.mock('../src/renderer/src/components/ScopeMenu', () => ({
  ScopeMenu: () => <button>Scope view</button>
}))

let files: X3FFileDTO[]
let importId = 0

beforeEach(() => {
  files = ['a', 'b'].map((name) => ({
    id: `${++importId}-${name}`,
    path: `/photos/${importId}-${name}.X3F`,
    fileName: `${name}.X3F`
  }))
  useQueueStore.setState({ files, activeId: files[0].id, selectedIds: new Set([files[0].id]) })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
  invoke.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('inspector metadata loading', () => {
  it('shows selected preview cards, common metadata, and mixed or missing values, then restores single-image mode', () => {
    const camera = { label: 'Camera', value: 'SIGMA' }
    files = [
      {
        ...files[0],
        exif: [camera, { label: 'ISO', value: '100' }, { label: 'Lens', value: '50mm' }]
      },
      {
        ...files[1],
        exif: [{ label: 'ISO', value: '200' }, camera, { label: 'Copyright', value: 'Owner' }]
      },
      { id: 'excluded', path: '/excluded.X3F', fileName: 'excluded.X3F', exif: [] }
    ]
    useQueueStore.setState({
      files,
      selectedIds: new Set([files[0].id, files[1].id]),
      activeId: files[1].id
    })
    render(<Inspector />)
    expect(screen.getByText('Info - 2 images')).toBeTruthy()
    const stack = screen.getByRole('group', { name: '2 images' })
    expect(stack.querySelectorAll('img')).toHaveLength(2)
    expect(stack.firstElementChild?.querySelector('img')?.getAttribute('alt')).toBe('b.X3F')
    expect(screen.queryByAltText('excluded.X3F')).toBeNull()
    expect(screen.getByText('Scopes not available for multiple images')).toBeTruthy()
    expect(screen.queryByTestId('scope')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Scope view' })).toBeNull()
    expect(screen.getByText('Camera').nextElementSibling?.textContent).toBe('SIGMA')
    expect(
      screen.getByText('Camera').nextElementSibling?.classList.contains('text-neutral-200')
    ).toBe(true)
    for (const label of ['ISO', 'Lens', 'Copyright']) {
      expect(screen.getByText(label).nextElementSibling?.textContent).toBe('Multiple values')
      expect(
        screen.getByText(label).nextElementSibling?.classList.contains('text-neutral-500')
      ).toBe(true)
    }
    expect(invoke).not.toHaveBeenCalled()

    act(() => useQueueStore.getState().setSelection(new Set([files[0].id]), files[0].id))
    expect(screen.getByText('Info - a.X3F')).toBeTruthy()
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByAltText('a.X3F')).toBeTruthy()
    expect(screen.getByTestId('scope')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Scope view' })).toBeTruthy()
    expect(screen.getByText('ISO').nextElementSibling?.textContent).toBe('100')
    act(() => useQueueStore.getState().deselectAll())
    expect(screen.getByText('Info')).toBeTruthy()
    expect(screen.getByText('Select a file to see its details')).toBeTruthy()
  })

  it('bounds the preview stack while retaining the full selection count and active image', () => {
    files = Array.from({ length: 1000 }, (_, i) => ({
      id: `stack-${i}`,
      path: `/stack-${i}.X3F`,
      fileName: `stack-${i}.X3F`,
      exif: []
    }))
    useQueueStore.setState({
      files,
      selectedIds: new Set(files.map((file) => file.id)),
      activeId: files[999].id
    })
    render(<Inspector />)
    expect(screen.getByText('Info - 1000 images')).toBeTruthy()
    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(
      screen.getByRole('group').firstElementChild?.querySelector('img')?.getAttribute('alt')
    ).toBe('stack-999.X3F')
    expect(screen.getByText('No metadata available')).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('waits for every selected image to finish import before claiming a common value', () => {
    const exif = [{ label: 'Camera', value: 'SIGMA' }]
    files = [
      { ...files[0], exif },
      { ...files[1], pending: true }
    ]
    useQueueStore.setState({ files, selectedIds: new Set(files.map((file) => file.id)) })
    const view = render(<Inspector />)
    expect(view.container.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(screen.queryByText('SIGMA')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
    act(() => useQueueStore.setState({ files: [files[0], { ...files[1], pending: false, exif }] }))
    expect(screen.getByText('SIGMA')).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('loads all selected fallbacks serially, handles failures, and drops stale queued selections', async () => {
    const selections = Array.from({ length: 4 }, (_, i) => ({
      ...files[0],
      id: `${files[0].id}-${i}`,
      path: `${files[0].path}-${i}`
    }))
    const finish = new Map<string, (pairs: ExifPair[]) => void>()
    invoke.mockImplementation(
      (_channel, { path }) =>
        new Promise((resolve, reject) => {
          if (path === selections[3].path) reject(new Error('unreadable'))
          else finish.set(path, resolve)
        })
    )
    const hook = renderHook(({ selected }) => useSelectionExif(selected), {
      initialProps: { selected: selections.slice(0, 3) }
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    const pairs = [{ label: 'Camera', value: 'SIGMA' }]
    await act(async () => finish.get(selections[0].path)!(pairs))
    expect(invoke).toHaveBeenLastCalledWith('exif:full', { path: selections[1].path })
    expect(hook.result.current).toBe('loading')
    hook.rerender({ selected: [selections[0], selections[3]] })
    await act(async () => finish.get(selections[1].path)!(pairs))
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(invoke).toHaveBeenLastCalledWith('exif:full', { path: selections[3].path })
    expect(hook.result.current).toEqual([pairs, []])
  })

  it('retains metadata for selections larger than the cache, including initial cache hits', async () => {
    const selections = Array.from({ length: 70 }, (_, i) => ({
      ...files[0],
      id: `${files[0].id}-large-${i}`,
      path: `${files[0].path}-large-${i}`
    }))
    const pairs = [{ label: 'Camera', value: 'SIGMA' }]
    invoke.mockResolvedValue(pairs)
    const hook = renderHook(({ selected }) => useSelectionExif(selected), {
      initialProps: { selected: selections.slice(0, 1) }
    })
    await waitFor(() => expect(hook.result.current).toEqual([pairs]))
    hook.rerender({ selected: selections })
    await waitFor(() => expect(hook.result.current).toEqual(selections.map(() => pairs)))
    expect(invoke).toHaveBeenCalledTimes(70)
  })

  it('uses imported EXIF immediately and does not start extraction while import hydration is pending', () => {
    const pairs = [{ label: 'Camera', value: 'Imported camera' }]
    useQueueStore.setState({ files: [{ ...files[0], pending: true }, files[1]] })
    const view = render(<Inspector />)
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(invoke).not.toHaveBeenCalled()

    act(() =>
      useQueueStore.setState({ files: [{ ...files[0], pending: true, exif: pairs }, files[1]] })
    )
    expect(screen.getByText('Imported camera')).toBeTruthy()
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()

    act(() => useQueueStore.setState({ files: [{ ...files[0], exif: pairs }, files[1]] }))
    expect(screen.getByText('Imported camera')).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('keeps only one running extraction and the latest of 20 rapid selections', async () => {
    const selections = Array.from({ length: 20 }, (_, index) => ({
      ...files[0],
      id: `${files[0].id}-${index}`,
      path: `${files[0].path}-${index}`
    }))
    const finish = new Map<string, (pairs: ExifPair[]) => void>()
    invoke.mockImplementation(
      (_channel, { path }) => new Promise((resolve) => finish.set(path, resolve))
    )
    const hook = renderHook(({ path, id }) => useExif(path, id), { initialProps: selections[0] })
    for (const file of selections.slice(1)) {
      hook.rerender(file)
      expect(hook.result.current).toBe('loading')
    }
    expect(invoke).toHaveBeenCalledTimes(1)
    const stale = [{ label: 'Camera', value: 'First camera' }]
    await act(async () => finish.get(selections[0].path)!(stale))
    expect(hook.result.current).toBe('loading')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('exif:full', { path: selections[19].path })
    const latest = [{ label: 'Camera', value: 'Last camera' }]
    await act(async () => finish.get(selections[19].path)!(latest))
    expect(hook.result.current).toBe(latest)
    hook.rerender(selections[0])
    expect(hook.result.current).toBe(stale)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('shares pending and running extraction among subscribers without cancelling the remaining listener', async () => {
    const finish = new Map<string, (pairs: ExifPair[]) => void>()
    invoke.mockImplementation(
      (_channel, { path }) => new Promise((resolve) => finish.set(path, resolve))
    )
    const blocker = renderHook(() => useExif(files[0].path, files[0].id))
    const first = renderHook(() => useExif(files[1].path, files[1].id))
    const second = renderHook(() => useExif(files[1].path, files[1].id))
    expect(invoke).toHaveBeenCalledTimes(1)
    first.unmount()
    await act(async () =>
      finish.get(files[0].path)!([{ label: 'Camera', value: 'Blocking camera' }])
    )
    expect(invoke).toHaveBeenCalledTimes(2)
    const third = renderHook(() => useExif(files[1].path, files[1].id))
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(second.result.current).toBe('loading')
    expect(third.result.current).toBe('loading')
    const pairs = [{ label: 'Camera', value: 'Shared camera' }]
    await act(async () => finish.get(files[1].path)!(pairs))
    expect(second.result.current).toBe(pairs)
    expect(third.result.current).toBe(pairs)
    expect(blocker.result.current).toEqual([{ label: 'Camera', value: 'Blocking camera' }])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('delays Skeletons for one second, resets the delay on selection, and never shows stale metadata', async () => {
    vi.useFakeTimers()
    const finish = new Map<string, (pairs: ExifPair[]) => void>()
    invoke.mockImplementation(
      (_channel, { path }) => new Promise((resolve) => finish.set(path, resolve))
    )
    const view = render(<Inspector />)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull()
    act(() => vi.advanceTimersByTime(999))
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(view.container.querySelectorAll('.rt-Skeleton')).toHaveLength(6)

    act(() => useQueueStore.getState().setSelection(new Set([files[1].id]), files[1].id))
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    act(() => vi.advanceTimersByTime(999))
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    await act(async () => finish.get(files[0].path)!([{ label: 'Camera', value: 'Camera A' }]))
    expect(screen.queryByText('Camera A')).toBeNull()
    await act(async () => finish.get(files[1].path)!([{ label: 'Camera', value: 'Camera B' }]))
    expect(screen.getByText('Camera B')).toBeTruthy()
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()

    act(() => useQueueStore.getState().setSelection(new Set([files[0].id]), files[0].id))
    expect(screen.getByText('Camera A')).toBeTruthy()
    expect(screen.queryByText('Camera B')).toBeNull()
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('returns cached metadata immediately and invalidates it when the same path is reimported', async () => {
    const first = [{ label: 'Camera', value: 'Camera A' }]
    const second = [{ label: 'Camera', value: 'Camera B' }]
    invoke.mockImplementation(async (_channel, { path }) =>
      path === files[0].path ? first : second
    )
    const hook = renderHook(({ path, id }) => useExif(path, id), { initialProps: files[0] })
    await waitFor(() => expect(hook.result.current).toBe(first))
    hook.rerender(files[1])
    expect(hook.result.current).toBe('loading')
    await waitFor(() => expect(hook.result.current).toBe(second))
    hook.rerender(files[0])
    expect(hook.result.current).toBe(first)
    expect(invoke).toHaveBeenCalledTimes(2)

    hook.rerender({ ...files[0], id: 'reimported' })
    expect(hook.result.current).toBe('loading')
    await waitFor(() => expect(hook.result.current).toBe(first))
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('retries an empty extraction result on a later visit', async () => {
    const pairs = [{ label: 'Camera', value: 'Camera recovered' }]
    invoke.mockResolvedValueOnce([]).mockResolvedValueOnce(pairs)
    const first = renderHook(() => useExif(files[0].path, files[0].id))
    await waitFor(() => expect(first.result.current).toEqual([]))
    first.unmount()
    const revisit = renderHook(() => useExif(files[0].path, files[0].id))
    expect(revisit.result.current).toBe('loading')
    await waitFor(() => expect(revisit.result.current).toBe(pairs))
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
