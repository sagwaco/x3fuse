// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'

const invoke = vi.fn<(channel: string, payload: { paths: string[] }) => Promise<X3FFileDTO[]>>()
;(window as unknown as { x3f: unknown }).x3f = { invoke }
const { useQueueStore: store } = await import('../src/renderer/src/stores/queueStore')
const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')

const paths = Array.from({ length: 17 }, (_, i) => `/photos/${String(i).padStart(2, '0')}.X3F`)

function metadata(paths: string[]): X3FFileDTO[] {
  return paths.map((path) => ({
    id: `main:${path}`,
    path,
    fileName: path.split('/').at(-1)!,
    fileSize: 1234,
    orientation: 6,
    aspectRatio: 1.5
  }))
}

function deferred() {
  let resolve!: (files: X3FFileDTO[]) => void
  const promise = new Promise<X3FFileDTO[]>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (_channel, payload) => metadata(payload.paths))
  store.setState({
    files: [],
    selectedIds: new Set(),
    activeId: null,
    draft: null,
    batch: null,
    error: null,
    isProcessing: false,
    isPreparing: false,
    isCancelling: false,
    pendingReconversion: null
  })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
})

afterEach(() => vi.restoreAllMocks())

describe('progressive file import', () => {
  it('shows every placeholder immediately and hydrates the active-first chunk before later chunks', async () => {
    const first = deferred()
    const second = deferred()
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const importing = store.getState().addFiles([...paths].reverse())
    const placeholders = store.getState().files
    const activeId = placeholders[0].id
    expect(placeholders).toHaveLength(17)
    expect(placeholders.every((file) => file.pending)).toBe(true)
    expect(store.getState().selectedIds).toEqual(new Set([activeId]))
    expect(invoke).toHaveBeenCalledTimes(1)
    const firstPaths = [paths[16], ...paths.slice(0, 7)]
    expect(invoke).toHaveBeenLastCalledWith('queue:add', { paths: firstPaths })

    first.resolve(metadata(firstPaths))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(invoke).toHaveBeenLastCalledWith('queue:add', { paths: paths.slice(7, 15) })
    expect(store.getState().files.filter((file) => !file.pending)).toHaveLength(8)
    expect(store.getState().files.filter((file) => file.pending)).toHaveLength(9)
    expect(store.getState().activeId).toBe(activeId)
    for (const file of store.getState().files.filter((file) => !file.pending)) {
      expect(file).toMatchObject({ fileSize: 1234, orientation: 6, aspectRatio: 1.5 })
      expect(firstPaths).toContain(file.path)
    }

    // Selection changes made during an import must survive every later response.
    const selected = placeholders.find((file) => file.path === paths[15])!.id
    store.getState().setSelection(new Set([selected]), selected)
    second.resolve(metadata(paths.slice(7, 15)))
    await importing
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(invoke).toHaveBeenLastCalledWith('queue:add', { paths: [paths[15]] })
    expect(store.getState().files.map((file) => file.id)).toEqual(
      placeholders.map((file) => file.id)
    )
    expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
    expect(store.getState().selectedIds).toEqual(new Set([selected]))
    expect(store.getState().activeId).toBe(selected)
  })

  it('uses the current descending order without changing an existing selection', async () => {
    const existing = { id: 'existing', path: '/old.X3F', fileName: 'old.X3F' }
    store.setState({
      files: [existing],
      selectedIds: new Set([existing.id]),
      activeId: existing.id
    })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, sortAscending: false } })
    await store.getState().addFiles([...paths.slice(0, 10), '/photos/ignored.jpg'])
    expect(invoke.mock.calls.map(([, payload]) => payload.paths)).toEqual([
      paths.slice(2, 10).reverse(),
      paths.slice(0, 2).reverse()
    ])
    expect(store.getState().files).toHaveLength(11)
    expect(store.getState().files[0]).toBe(existing)
    expect(store.getState().selectedIds).toEqual(new Set([existing.id]))
    expect(store.getState().activeId).toBe(existing.id)
  })

  it('never restores removed placeholders, including after the queue is cleared', async () => {
    const first = deferred()
    const second = deferred()
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const importing = store.getState().addFiles(paths)
    const removedIds = new Set([store.getState().files[0].id, store.getState().files[9].id])
    store.getState().removeFiles(removedIds)
    first.resolve(metadata(paths.slice(0, 8)))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(store.getState().files).toHaveLength(15)
    expect(store.getState().files.some((file) => removedIds.has(file.id))).toBe(false)
    expect(store.getState().activeId).toBeNull()
    expect(store.getState().selectedIds.size).toBe(0)
    const secondPaths = invoke.mock.calls[1][1].paths
    expect(secondPaths).toEqual(paths.slice(8, 16).filter((path) => path !== paths[9]))

    store.getState().clearQueue()
    second.resolve(metadata(secondPaths))
    await importing
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(store.getState().files).toEqual([])
    expect(store.getState().activeId).toBeNull()
    expect(store.getState().selectedIds.size).toBe(0)
  })

  it('matches responses to surviving rows when an unrequested row is removed', async () => {
    const first = deferred()
    invoke
      .mockImplementation(async (_channel, payload) =>
        metadata(payload.paths).map((file) => ({ ...file, fileSize: paths.indexOf(file.path) }))
      )
      .mockReturnValueOnce(first.promise)
    const importing = store.getState().addFiles(paths)
    const removedId = store.getState().files[9].id
    store.getState().removeFiles(new Set([removedId]))
    first.resolve(metadata(paths.slice(0, 8)))
    await importing
    expect(invoke.mock.calls[1][1].paths).toEqual(
      paths.slice(8, 16).filter((path) => path !== paths[9])
    )
    expect(store.getState().files).toHaveLength(16)
    expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
    for (const file of store.getState().files.filter((file) => paths.indexOf(file.path) >= 8)) {
      expect(file.fileSize).toBe(paths.indexOf(file.path))
      expect(file.id).not.toBe(removedId)
    }
  })

  it('rolls back only a failed chunk and continues importing later chunks', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke
      .mockResolvedValueOnce(metadata(paths.slice(0, 8)))
      .mockRejectedValueOnce(new Error('Unreadable batch'))
    const importing = store.getState().addFiles(paths)
    const placeholders = store.getState().files
    store
      .getState()
      .setSelection(
        new Set([placeholders[0].id, placeholders[8].id, placeholders[16].id]),
        placeholders[8].id
      )
    await importing
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(error).toHaveBeenCalledTimes(1)
    expect(store.getState().files.map((file) => file.path)).toEqual([
      ...paths.slice(0, 8),
      paths[16]
    ])
    expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
    expect(store.getState().selectedIds).toEqual(new Set([placeholders[0].id, placeholders[16].id]))
    expect(store.getState().activeId).toBeNull()
  })

  it('drops missing results in one chunk without discarding later files', async () => {
    invoke.mockResolvedValueOnce(metadata(paths.slice(0, 7)))
    await store.getState().addFiles(paths.slice(0, 9))
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(store.getState().files.map((file) => file.path)).toEqual([
      ...paths.slice(0, 7),
      paths[8]
    ])
    expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
  })
})
