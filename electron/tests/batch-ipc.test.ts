import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { IpcPayload, IpcRequestChannel } from '@shared/ipc'
import { batchSettings, DEFAULT_SETTINGS } from '@shared/types'
import type { AppContext } from '../src/main/context'
import type { WindowManager } from '../src/main/windows'

const mocks = vi.hoisted(() => ({
  disk: {} as Record<string, unknown>,
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  app: {},
  dialog: {},
  shell: {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('electron-store', () => ({
  default: class {
    get store(): Record<string, unknown> {
      return structuredClone(mocks.disk)
    }
    set store(value: Record<string, unknown>) {
      mocks.disk = structuredClone(value)
    }
  }
}))
const { SettingsService } = await import('../src/main/services/SettingsService')
const { registerIpcHandlers } = await import('../src/main/ipc/router')
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'x3f-ipc-'))
  mocks.disk = { ...DEFAULT_SETTINGS, onlyProcessNewItems: true, outputFormat: 'tiff' }
  mocks.handlers.clear()
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function setup(running = false): {
  settings: InstanceType<typeof SettingsService>
  convert: ReturnType<typeof vi.fn>
} {
  const settings = new SettingsService()
  const convert = vi.fn(async () => undefined)
  registerIpcHandlers(
    { settings, conversion: { convert, isRunning: running } } as unknown as AppContext,
    {} as WindowManager,
    (key) => key
  )
  return { settings, convert }
}
function invoke<C extends IpcRequestChannel>(channel: C, payload: IpcPayload<C>): unknown {
  return mocks.handlers.get(channel)!(null, payload)
}
function request() {
  return {
    batchId: 'batch',
    files: [{ id: 'a', path: '/photos/a.X3F' }],
    settings: { ...batchSettings(DEFAULT_SETTINGS), outputDirectory: directory },
    replaceExisting: false
  }
}

describe('batch IPC and persistence', () => {
  it('migrates old preferences without inventing a previous batch, and persists an accepted snapshot across relaunch', async () => {
    const { settings, convert } = setup()
    expect(settings.get().outputFormat).toBe('tiff')
    expect(settings.get().hasPreviousConversion).toBe(false)
    expect(mocks.disk).not.toHaveProperty('onlyProcessNewItems')
    const batch = request()
    await invoke('convert:start', batch)
    expect(convert).toHaveBeenCalledWith(batch.files, batch.settings, 'batch')
    const relaunched = new SettingsService().get()
    expect(relaunched).toMatchObject({ ...batch.settings, hasPreviousConversion: true })
    expect(relaunched.debugLoggingEnabled).toBe(false)
  })

  it('preflight does not persist a draft; unconfirmed overwrites never start or save', async () => {
    const { settings, convert } = setup()
    const previous = settings.get()
    await writeFile(join(directory, 'a.dng'), 'existing')
    const batch = request()
    await expect(invoke('queue:existingOutputs', batch)).resolves.toHaveLength(1)
    expect(settings.get()).toEqual(previous)
    await expect(invoke('convert:start', batch)).rejects.toThrow('already exist')
    expect(convert).not.toHaveBeenCalled()
    expect(settings.get()).toEqual(previous)
    await invoke('convert:start', { ...batch, replaceExisting: true })
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('rejects a busy converter or invalid destination without changing previous settings', async () => {
    const { settings, convert } = setup(true)
    const previous = settings.get()
    await expect(invoke('convert:start', request())).rejects.toThrow('already running')
    await expect(
      invoke('convert:start', {
        ...request(),
        settings: { ...request().settings, outputDirectory: join(directory, 'missing') }
      })
    ).rejects.toThrow()
    expect(settings.get()).toEqual(previous)
    expect(convert).not.toHaveBeenCalled()
  })
})
