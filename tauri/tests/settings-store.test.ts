import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ConversionSettings } from '@shared/types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))

beforeEach(() => {
  vi.resetModules()
  invoke.mockReset()
})

function deferred() {
  let resolve!: (settings: ConversionSettings) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ConversionSettings>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it('renders rapid changes immediately, saves in order, and ignores an older focus refresh', async () => {
  const { useSettingsStore: store } = await import('../src/renderer/src/stores/settingsStore')
  const refresh = deferred()
  const first = deferred()
  const second = deferred()
  invoke
    .mockReturnValueOnce(refresh.promise)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  const loading = store.getState().load()
  const a = store.getState().update({ queueViewMode: 'grid' })
  const b = store.getState().update({ queueViewMode: 'filmstrip', inspectorOpen: false })
  expect(store.getState().settings).toMatchObject({
    queueViewMode: 'filmstrip',
    inspectorOpen: false
  })
  expect(invoke).toHaveBeenCalledTimes(2)
  refresh.resolve({ ...DEFAULT_SETTINGS })
  await loading
  expect(store.getState().settings.queueViewMode).toBe('filmstrip')
  first.resolve({ ...DEFAULT_SETTINGS, queueViewMode: 'grid' })
  await a
  expect(invoke).toHaveBeenLastCalledWith('settings:set', {
    queueViewMode: 'filmstrip',
    inspectorOpen: false
  })
  expect(store.getState().settings).toMatchObject({
    queueViewMode: 'filmstrip',
    inspectorOpen: false
  })
  second.resolve({ ...DEFAULT_SETTINGS, queueViewMode: 'filmstrip', inspectorOpen: false })
  await b
  expect(store.getState().loaded).toBe(true)
  expect(store.getState().settings).toMatchObject({
    queueViewMode: 'filmstrip',
    inspectorOpen: false
  })
})

it('rolls back failed saves without losing newer edits and continues saving', async () => {
  const { useSettingsStore: store } = await import('../src/renderer/src/stores/settingsStore')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const first = deferred()
  const second = deferred()
  invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const a = store.getState().update({ queueViewMode: 'grid' })
  const b = store.getState().update({ queueViewMode: 'filmstrip' })
  first.reject(new Error('Disk full'))
  await a
  expect(store.getState().settings.queueViewMode).toBe('filmstrip')
  second.reject(new Error('Disk full'))
  await b
  expect(store.getState().settings.queueViewMode).toBe(DEFAULT_SETTINGS.queueViewMode)
  invoke.mockResolvedValue({ ...DEFAULT_SETTINGS, inspectorOpen: false })
  await store.getState().update({ inspectorOpen: false })
  expect(store.getState().settings.inspectorOpen).toBe(false)
  expect(error).toHaveBeenCalledTimes(2)
  error.mockRestore()
})

it('keeps committed batch settings through pending saves and stale refreshes', async () => {
  const { useSettingsStore: store } = await import('../src/renderer/src/stores/settingsStore')
  const save = deferred()
  invoke.mockReturnValueOnce(save.promise)
  const pending = store.getState().update({ outputFormat: 'tiff', queueViewMode: 'filmstrip' })
  store.getState().accept({ outputFormat: 'embeddedJpg', hasPreviousConversion: true })
  expect(store.getState().settings.outputFormat).toBe('embeddedJpg')
  await store.getState().load()
  expect(invoke).toHaveBeenCalledOnce()
  save.resolve({ ...DEFAULT_SETTINGS, outputFormat: 'tiff', queueViewMode: 'filmstrip' })
  await pending
  expect(store.getState().settings).toMatchObject({
    outputFormat: 'embeddedJpg',
    hasPreviousConversion: true,
    queueViewMode: 'filmstrip'
  })
  const refresh = deferred()
  invoke.mockReturnValueOnce(refresh.promise)
  const loading = store.getState().load()
  store.getState().accept({ outputFormat: 'dng' })
  refresh.resolve({ ...DEFAULT_SETTINGS, outputFormat: 'tiff' })
  await loading
  expect(store.getState().settings.outputFormat).toBe('dng')
})

it('does not persist queued fields superseded by a committed batch', async () => {
  const { useSettingsStore: store } = await import('../src/renderer/src/stores/settingsStore')
  const save = deferred()
  invoke.mockReturnValueOnce(save.promise)
  const first = store.getState().update({ queueViewMode: 'filmstrip' })
  const queued = store.getState().update({ outputFormat: 'tiff' })
  store.getState().accept({ outputFormat: 'embeddedJpg', hasPreviousConversion: true })
  save.resolve({ ...DEFAULT_SETTINGS, queueViewMode: 'filmstrip' })
  await Promise.all([first, queued])
  expect(invoke).toHaveBeenCalledOnce()
  expect(store.getState().settings.outputFormat).toBe('embeddedJpg')
  invoke.mockResolvedValue({ ...store.getState().settings, outputFormat: 'dng' })
  await store.getState().update({ outputFormat: 'dng' })
  expect(invoke).toHaveBeenLastCalledWith('settings:set', { outputFormat: 'dng' })
  expect(store.getState().settings.outputFormat).toBe('dng')
})
