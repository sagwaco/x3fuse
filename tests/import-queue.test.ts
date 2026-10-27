// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'

const invoke = vi.fn<(channel: string, payload: { paths: string[] }) => Promise<X3FFileDTO[]>>()
;(window as unknown as { x3f: unknown }).x3f = { invoke }
const {
  useQueueStore: store,
  shownFiles,
  setShownRows
} = await import('../src/renderer/src/stores/queueStore')
const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
const { useNavStore } = await import('../src/renderer/src/stores/navStore')

const paths = Array.from({ length: 17 }, (_, i) => `/photos/${String(i).padStart(2, '0')}.X3F`)

function metadata(paths: string[]): X3FFileDTO[] {
  return paths.map((path) => ({
    id: `main:${path}`,
    path,
    fileName: path.split('/').at(-1)!,
    fileSize: 1234,
    orientation: 6,
    aspectRatio: 1.5,
    exif: [{ label: 'Camera', value: 'Sigma' }],
    frames: 7
  }))
}

/** Later paths are older photos. */
function dated(chunk: string[]): X3FFileDTO[] {
  return metadata(chunk).map((file) => ({
    ...file,
    capturedDate: new Date(Date.UTC(2024, 0, 31 - paths.indexOf(file.path))).toISOString()
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
    pendingReconversion: null,
    filter: { flags: [], rating: 0, ratingOp: 'atLeast' }
  })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
  useNavStore.setState({ screen: 'queue' })
})

afterEach(() => vi.restoreAllMocks())

describe('progressive file import', () => {
  it('shows every placeholder immediately and hydrates from the first shown photo', async () => {
    const calls = [deferred(), deferred(), deferred()]
    calls.forEach(({ promise }) => invoke.mockReturnValueOnce(promise))
    // The open dialog and Finder can give the last photo first.
    const importing = store.getState().addFiles([...paths].reverse())
    const placeholders = store.getState().files
    const activeId = placeholders.find((file) => file.path === paths[0])!.id
    expect(placeholders).toHaveLength(17)
    expect(placeholders.every((file) => file.pending)).toBe(true)
    expect(store.getState().selectedIds).toEqual(new Set([activeId]))
    expect(store.getState().activeId).toBe(activeId)
    // The active photo and its neighbor go alone; three batches run at once.
    expect(invoke.mock.calls.map(([, payload]) => payload.paths)).toEqual([
      paths.slice(0, 2),
      paths.slice(2, 10),
      paths.slice(10)
    ])

    calls[0].resolve(metadata(paths.slice(0, 2)))
    await vi.waitFor(() =>
      expect(store.getState().files.filter((file) => !file.pending)).toHaveLength(2)
    )
    expect(store.getState().activeId).toBe(activeId)
    for (const file of store.getState().files.filter((file) => !file.pending)) {
      expect(file).toMatchObject({
        fileSize: 1234,
        orientation: 6,
        aspectRatio: 1.5,
        exif: [{ label: 'Camera', value: 'Sigma' }],
        frames: 7
      })
      expect(paths.slice(0, 2)).toContain(file.path)
    }

    // Selection changes made during an import must survive every later response.
    const selected = placeholders.find((file) => file.path === paths[16])!.id
    store.getState().setSelection(new Set([selected]), selected)
    calls[2].resolve(metadata(paths.slice(10)))
    calls[1].resolve(metadata(paths.slice(2, 10)))
    await importing
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(store.getState().files.map((file) => file.id)).toEqual(
      placeholders.map((file) => file.id)
    )
    expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
    expect(store.getState().selectedIds).toEqual(new Set([selected]))
    expect(store.getState().activeId).toBe(selected)
  })

  it('shows photos that the backend has cached while a slow photo in another batch imports', async () => {
    const slow = deferred()
    invoke.mockImplementation(async (_channel, payload) =>
      payload.paths.includes(paths[0]) ? slow.promise : metadata(payload.paths)
    )
    const importing = store.getState().addFiles(paths)
    const activeId = store.getState().activeId
    await vi.waitFor(() =>
      expect(store.getState().files.filter((file) => !file.pending)).toHaveLength(15)
    )
    expect(
      store
        .getState()
        .files.filter((file) => file.pending)
        .map((file) => file.path)
    ).toEqual(paths.slice(0, 2))
    expect(store.getState().activeId).toBe(activeId)
    slow.resolve(metadata(paths.slice(0, 2)))
    await importing
    expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
    expect(store.getState().activeId).toBe(activeId)
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
    // The neighbor of the existing active row goes first.
    expect(invoke.mock.calls.map(([, payload]) => payload.paths)).toEqual([
      [paths[9]],
      paths.slice(1, 9).reverse(),
      [paths[0]]
    ])
    expect(store.getState().files).toHaveLength(11)
    expect(store.getState().files[0]).toBe(existing)
    expect(store.getState().selectedIds).toEqual(new Set([existing.id]))
    expect(store.getState().activeId).toBe(existing.id)
  })

  it('never restores removed placeholders, including after the queue is cleared', async () => {
    const calls = [deferred(), deferred(), deferred()]
    calls.forEach(({ promise }) => invoke.mockReturnValueOnce(promise))
    const importing = store.getState().addFiles(paths)
    const removedIds = new Set([store.getState().files[0].id, store.getState().files[9].id])
    store.getState().removeFiles(removedIds)
    calls[0].resolve(metadata(paths.slice(0, 2)))
    calls[1].resolve(metadata(paths.slice(2, 10)))
    await vi.waitFor(() =>
      expect(store.getState().files.filter((file) => !file.pending)).toHaveLength(8)
    )
    expect(store.getState().files).toHaveLength(15)
    expect(store.getState().files.some((file) => removedIds.has(file.id))).toBe(false)
    expect(store.getState().activeId).toBeNull()
    expect(store.getState().selectedIds.size).toBe(0)

    store.getState().clearQueue()
    calls[2].resolve(metadata(paths.slice(10)))
    await importing
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(store.getState().files).toEqual([])
    expect(store.getState().activeId).toBeNull()
    expect(store.getState().selectedIds.size).toBe(0)
  })

  it('matches responses to surviving rows when a requested row is removed', async () => {
    const first = deferred()
    invoke
      .mockImplementation(async (_channel, payload) =>
        metadata(payload.paths).map((file) => ({ ...file, fileSize: paths.indexOf(file.path) }))
      )
      .mockReturnValueOnce(first.promise)
    const importing = store.getState().addFiles(paths)
    const removedId = store.getState().files[9].id
    store.getState().removeFiles(new Set([removedId]))
    first.resolve(metadata(paths.slice(0, 2)))
    await importing
    expect(invoke.mock.calls[1][1].paths).toEqual(paths.slice(2, 10))
    expect(store.getState().files).toHaveLength(16)
    expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
    for (const file of store.getState().files.filter((file) => paths.indexOf(file.path) >= 2)) {
      expect(file.fileSize).toBe(paths.indexOf(file.path))
      expect(file.id).not.toBe(removedId)
    }
  })

  it('rolls back only a failed chunk and continues importing later chunks', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke
      .mockResolvedValueOnce(metadata(paths.slice(0, 2)))
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
      ...paths.slice(0, 2),
      ...paths.slice(10)
    ])
    expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
    expect(store.getState().selectedIds).toEqual(new Set([placeholders[0].id, placeholders[16].id]))
    expect(store.getState().activeId).toBeNull()
  })

  it('drops missing results in one chunk without discarding later files', async () => {
    invoke.mockResolvedValueOnce(metadata(paths.slice(0, 1)))
    await store.getState().addFiles(paths.slice(0, 9))
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(store.getState().files.map((file) => file.path)).toEqual([
      paths[0],
      ...paths.slice(2, 9)
    ])
    expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
  })

  it('follows the first shown photo while dates arrive', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, sortField: 'Date' } })
    invoke.mockImplementation(async (_channel, payload) => dated(payload.paths))
    const active: string[] = []
    const off = store.subscribe((s) => {
      const path = s.files.find((file) => file.id === s.activeId)?.path
      if (path && active.at(-1) !== path) active.push(path)
    })
    await store.getState().addFiles(paths)
    off()
    expect(invoke.mock.calls.map(([, payload]) => payload.paths)).toEqual([
      paths.slice(0, 2),
      paths.slice(2, 10),
      paths.slice(10)
    ])
    // Placeholders wait after the loaded photos, so the selection stays on the first row.
    expect(active).toEqual([paths[0], paths[1], paths[9], paths[16]])
    expect(shownFiles(store.getState())[0].id).toBe(store.getState().activeId)
  })

  it('ignores a response for rows that a Clear removed', async () => {
    const a = [deferred(), deferred()]
    const b = deferred()
    a.forEach(({ promise }) => invoke.mockReturnValueOnce(promise))
    const importingA = store.getState().addFiles(paths.slice(0, 3))
    store.getState().clearQueue()
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, sortField: 'Date' } })
    invoke
      .mockImplementation(async (_channel, payload) => dated(payload.paths))
      .mockReturnValueOnce(b.promise)
    const importingB = store.getState().addFiles(paths)
    a[0].resolve(metadata(paths.slice(0, 2)))
    a[1].resolve(metadata(paths.slice(2, 3)))
    await importingA
    b.resolve(dated(paths.slice(0, 2)))
    await importingB
    // Import B still follows its first shown photo: the oldest one.
    const oldest = store.getState().files.find((file) => file.path === paths[16])!.id
    expect(store.getState().activeId).toBe(oldest)
    expect(store.getState().selectedIds).toEqual(new Set([oldest]))
  })

  it('stops following after a visit to another screen', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, sortField: 'Date' } })
    const first = deferred()
    invoke
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (_channel, payload) => dated(payload.paths))
    const importing = store.getState().addFiles(paths)
    const activeId = store.getState().activeId
    useNavStore.getState().goToExport()
    useNavStore.getState().goToQueue()
    first.resolve(dated(paths.slice(0, 8)))
    await importing
    expect(store.getState().activeId).toBe(activeId)
    expect(store.getState().selectedIds).toEqual(new Set([activeId]))
  })

  it('selects nothing while a filter hides every placeholder', async () => {
    store.setState({ filter: { flags: ['pick'], rating: 0, ratingOp: 'atLeast' } })
    invoke.mockImplementation(async (_channel, payload) =>
      metadata(payload.paths).map((file) => ({
        ...file,
        flag: paths.indexOf(file.path) % 5 === 3 ? 'pick' : undefined
      }))
    )
    const importing = store.getState().addFiles(paths)
    expect(store.getState().activeId).toBeNull()
    expect(store.getState().selectedIds.size).toBe(0)
    await importing
    const pick = store.getState().files.find((file) => file.path === paths[3])!.id
    expect(store.getState().activeId).toBe(pick)
    expect(store.getState().selectedIds).toEqual(new Set([pick]))
  })
})

it('reprioritizes a newly selected pending file before the next import batch', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `/photos/${String(i).padStart(2, '0')}.X3F`)
  const first = deferred()
  invoke.mockReturnValueOnce(first.promise)
  const importing = store.getState().addFiles(many)
  const selected = store.getState().files[39].id
  store.getState().setSelection(new Set([selected]), selected)
  first.resolve(metadata(many.slice(0, 2)))
  await importing
  // The three first batches started at once; the first free one takes the selection.
  expect(invoke.mock.calls[3][1].paths).toEqual([many[39], many[38]])
  expect(store.getState().activeId).toBe(selected)
  expect(store.getState().files.find((file) => file.id === selected)?.exif).toEqual([
    { label: 'Camera', value: 'Sigma' }
  ])
})

it('imports the pending rows of a scrolled view before the offscreen remainder', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `/photos/${String(i).padStart(2, '0')}.X3F`)
  const first = deferred()
  invoke.mockReturnValueOnce(first.promise)
  const importing = store.getState().addFiles(many)
  const activeId = store.getState().activeId
  // The user scrolls far down without a change of the active photo.
  const view = {}
  const shown = store.getState().files.slice(30, 36)
  setShownRows(
    view,
    shown.map((file) => file.id)
  )
  first.resolve(metadata(many.slice(0, 2)))
  await importing
  setShownRows(view, null)
  const batches = invoke.mock.calls.map(([, payload]) => payload.paths)
  // Three batches started at once; the first free one takes the shown rows, in shown order.
  expect(batches.slice(0, 3)).toEqual([many.slice(0, 2), many.slice(2, 10), many.slice(10, 18)])
  expect(batches[3]).toEqual(many.slice(30, 34))
  expect(batches.findIndex((paths) => paths.includes(many[35]))).toBeLessThan(
    batches.findIndex((paths) => paths.includes(many[18]))
  )
  expect(store.getState().activeId).toBe(activeId)
  expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
})

it('publishes only the pending rows that a virtualized grid renders, and forgets them on unmount', async () => {
  const { renderHook } = await import('@testing-library/react')
  const { useShownRows } = await import('../src/renderer/src/hooks/useScrollToActive')
  const many = Array.from({ length: 40 }, (_, i) => `/photos/${String(i).padStart(2, '0')}.X3F`)
  const calls = [deferred(), deferred(), deferred(), deferred()]
  calls.forEach(({ promise }) => invoke.mockReturnValueOnce(promise))
  const importing = store.getState().addFiles(many)
  const files = store
    .getState()
    .files.map((file, i) => (i === 31 ? { ...file, pending: false } : file))
  // Rows 10 and 11 of a three-column grid: items 30 to 35.
  const virtualizer = { getVirtualItems: () => [{ index: 10 }, { index: 11 }] }
  const hook = renderHook(() =>
    useShownRows(virtualizer as unknown as Parameters<typeof useShownRows>[0], files, 3)
  )
  calls[0].resolve(metadata(many.slice(0, 2)))
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(4))
  expect(invoke.mock.calls[3][1].paths).toEqual([many[30], ...many.slice(32, 35)])
  hook.unmount()
  calls[1].resolve(metadata(many.slice(2, 10)))
  await vi.waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThanOrEqual(5))
  // After the unmount the rows wait in shown order again.
  expect(invoke.mock.calls[4][1].paths).toEqual(many.slice(18, 26))
  calls[2].resolve(metadata(many.slice(10, 18)))
  calls[3].resolve(metadata([many[30], ...many.slice(32, 35)]))
  await importing
  expect(store.getState().files.every((file) => file.pending === false)).toBe(true)
})
