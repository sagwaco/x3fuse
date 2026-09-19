import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppContext } from '../src/main/context'
import type { WindowManager } from '../src/main/windows'
import { registerIpcHandlers } from '../src/main/ipc/router'
import { BinaryResolver } from '../src/main/services/BinaryResolver'
import { ExifService } from '../src/main/services/ExifService'
import { PreviewService } from '../src/main/services/PreviewService'
import {
  spawnCapture,
  spawnCaptureBinary,
  type RunResultBinary
} from '../src/main/services/ProcessRunner'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => unknown>())
vi.mock('electron', () => ({
  app: {},
  dialog: {},
  shell: {},
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => unknown) =>
      handlers.set(name, handler)
  }
}))
vi.mock('../src/main/ipc/nativeMenu', () => ({ registerNativeMenuHandlers: vi.fn() }))
vi.mock('../src/main/services/ProcessRunner', () => ({
  spawnCapture: vi.fn(),
  spawnCaptureBinary: vi.fn()
}))

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const thumbnail = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9])
const encoded = (bytes: Buffer): string => `base64:${bytes.toString('base64')}`
const child = {} as ChildProcess
const resolver = new BinaryResolver('/resources')
const binaryResult = (stdout = jpeg, code = 0): RunResultBinary => ({
  stdout,
  code,
  signal: null,
  stderr: ''
})
let directory: string

beforeEach(async () => {
  vi.clearAllMocks()
  directory = await mkdtemp(join(tmpdir(), 'x3f-preview-'))
  vi.mocked(spawnCaptureBinary).mockImplementation(() => ({
    child,
    result: Promise.resolve(binaryResult())
  }))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function file(name = 'image'): Promise<string> {
  const path = join(directory, `${name}.X3F`)
  await writeFile(path, 'X3F')
  return path
}

function metadata(value: unknown): void {
  vi.mocked(spawnCapture).mockReturnValue({
    child,
    result: Promise.resolve({
      code: 0,
      signal: null,
      stderr: '',
      stdout: JSON.stringify(value)
    })
  })
}

describe('import preview extraction', () => {
  it('extracts metadata and the first valid small JPEG in one exiftool invocation', async () => {
    metadata([
      {
        SourceFile: 'a.X3F',
        Orientation: 6,
        ImageWidth: 3,
        ImageHeight: 2,
        PreviewImage: encoded(jpeg),
        ThumbnailImage: encoded(thumbnail)
      },
      {
        SourceFile: 'b.X3F',
        PreviewImage: encoded(Buffer.from('invalid')),
        ThumbnailImage: encoded(thumbnail)
      },
      { SourceFile: 'c.X3F', PreviewImage: 'not base64', ThumbnailImage: encoded(Buffer.alloc(0)) }
    ])
    const map = await new ExifService(resolver).displayMeta(['a.X3F', 'b.X3F', 'c.X3F'])
    expect(map.get('a.X3F')).toEqual({ orientation: 6, aspectRatio: 1.5, preview: jpeg })
    expect(map.get('b.X3F')).toEqual({ preview: thumbnail })
    expect(map.get('c.X3F')).toEqual({})
    expect(spawnCapture).toHaveBeenCalledTimes(1)
    expect(vi.mocked(spawnCapture).mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        '-PreviewImage',
        '-ThumbnailImage',
        '-Orientation',
        '-ImageWidth',
        '-ImageHeight',
        '-b',
        '-json'
      ])
    )
    expect(spawnCaptureBinary).not.toHaveBeenCalled()
  })

  it('returns metadata without requiring an embedded JPEG and tolerates process failure', async () => {
    metadata([{ SourceFile: 'a.X3F', Orientation: 8 }])
    const exif = new ExifService(resolver)
    expect((await exif.displayMeta(['a.X3F'])).get('a.X3F')).toEqual({ orientation: 8 })
    vi.mocked(spawnCapture).mockReturnValueOnce({
      child,
      result: Promise.reject(new Error('missing exiftool'))
    })
    expect(await exif.displayMeta(['a.X3F'])).toEqual(new Map())
    expect(await exif.displayMeta([])).toEqual(new Map())
    expect(spawnCapture).toHaveBeenCalledTimes(2)
  })

  it('primes thumbnails before queue:add resolves, without sending JPEG bytes through IPC', async () => {
    const path = await file()
    metadata([
      {
        SourceFile: path,
        Orientation: 6,
        ImageWidth: 3,
        ImageHeight: 2,
        PreviewImage: encoded(jpeg)
      }
    ])
    const preview = new PreviewService(resolver)
    registerIpcHandlers(
      { exif: new ExifService(resolver), preview } as AppContext,
      {} as WindowManager,
      (key) => key
    )
    const dtos = await handlers.get('queue:add')!(null, { paths: [path] })
    expect(dtos).toEqual([expect.objectContaining({ path, orientation: 6, aspectRatio: 1.5 })])
    expect((dtos as object[])[0]).not.toHaveProperty('preview')
    expect(await preview.getJpeg(path, 'preview')).toEqual(jpeg)
    expect(spawnCaptureBinary).not.toHaveBeenCalled()
  })
})

describe('PreviewService cache and extraction', () => {
  it('coalesces overlapping requests and invalidates cached JPEGs when the source changes', async () => {
    const path = await file()
    const service = new PreviewService(resolver)
    let finish!: (result: RunResultBinary) => void
    vi.mocked(spawnCaptureBinary).mockReturnValueOnce({
      child,
      result: new Promise((resolve) => {
        finish = resolve
      })
    })
    const requests = Array.from({ length: 8 }, () => service.getJpeg(path, 'preview'))
    await vi.waitFor(() => expect(spawnCaptureBinary).toHaveBeenCalledTimes(1))
    finish(binaryResult())
    expect(await Promise.all(requests)).toEqual(Array(8).fill(jpeg))
    expect(spawnCaptureBinary).toHaveBeenCalledTimes(1)
    expect(await service.getJpeg(path, 'preview')).toEqual(jpeg)
    expect(spawnCaptureBinary).toHaveBeenCalledTimes(1)
    await utimes(path, new Date(0), new Date(0))
    expect(await service.getJpeg(path, 'preview')).toEqual(jpeg)
    expect(spawnCaptureBinary).toHaveBeenCalledTimes(2)
  })

  it('keeps full and small variants separate and never substitutes an untagged preview for full', async () => {
    const path = await file()
    const service = new PreviewService(resolver)
    await service.prime(path, jpeg)
    vi.mocked(spawnCaptureBinary).mockReturnValueOnce({
      child,
      result: Promise.resolve(binaryResult(Buffer.alloc(0)))
    })
    expect(await service.getJpeg(path, 'full')).toBeNull()
    expect(spawnCaptureBinary).toHaveBeenCalledTimes(1)
    expect(spawnCaptureBinary).toHaveBeenCalledWith(resolver.exiftool().command, [
      '-b',
      '-JpgFromRaw',
      path
    ])
    expect(await service.getJpeg(path, 'preview')).toEqual(jpeg)
    expect(spawnCaptureBinary).toHaveBeenCalledTimes(1)
  })

  it('falls back from a missing PreviewImage and retries after extraction failure', async () => {
    const path = await file()
    const service = new PreviewService(resolver)
    vi.mocked(spawnCaptureBinary)
      .mockImplementationOnce(() => ({
        child,
        result: Promise.reject(new Error('process failed'))
      }))
      .mockReturnValueOnce({ child, result: Promise.resolve(binaryResult(thumbnail)) })
    expect(await service.getJpeg(path, 'preview')).toEqual(thumbnail)
    expect(vi.mocked(spawnCaptureBinary).mock.calls.map(([, args]) => args[1])).toEqual([
      '-PreviewImage',
      '-ThumbnailImage'
    ])
    vi.mocked(spawnCaptureBinary).mockImplementationOnce(() => ({
      child,
      result: Promise.reject(new Error('process failed'))
    }))
    expect(await service.getJpeg(path, 'full')).toBeNull()
    expect(await service.getJpeg(path, 'full')).toEqual(jpeg)
  })

  it('limits concurrent extractions to four and releases slots on failed requests', async () => {
    const paths = await Promise.all(Array.from({ length: 6 }, (_, i) => file(String(i))))
    const finishes: ((result: RunResultBinary) => void)[] = []
    vi.mocked(spawnCaptureBinary).mockImplementation(() => ({
      child,
      result: new Promise((resolve) => {
        finishes.push(resolve)
      })
    }))
    const service = new PreviewService(resolver)
    const requests = paths.map((path) => service.getJpeg(path, 'full'))
    await vi.waitFor(() => expect(finishes).toHaveLength(4))
    finishes[0](binaryResult(Buffer.alloc(0), 1))
    await vi.waitFor(() => expect(finishes).toHaveLength(5))
    finishes[1](binaryResult())
    await vi.waitFor(() => expect(finishes).toHaveLength(6))
    finishes.slice(2).forEach((finish) => finish(binaryResult()))
    const results = await Promise.all(requests)
    expect(results.filter((bytes) => bytes === null)).toHaveLength(1)
    expect(results.filter((bytes) => bytes?.equals(jpeg))).toHaveLength(5)
  })

  it('counts replacements once and evicts the least recently used entry', async () => {
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(file))
    const large = Buffer.alloc(48 * 1024 * 1024)
    jpeg.copy(large)
    const service = new PreviewService(resolver)
    await service.prime(a, large)
    await service.prime(b, large)
    await service.prime(a, large)
    expect(await service.getJpeg(a, 'preview')).toBe(large)
    await service.prime(c, large)
    expect(await service.getJpeg(a, 'preview')).toBe(large)
    expect(await service.getJpeg(c, 'preview')).toBe(large)
    expect(spawnCaptureBinary).not.toHaveBeenCalled()
    expect(await service.getJpeg(b, 'preview')).toEqual(jpeg)
    expect(spawnCaptureBinary).toHaveBeenCalledTimes(1)
  })

  it('ignores invalid priming bytes and missing files', async () => {
    const path = await file()
    const service = new PreviewService(resolver)
    await service.prime(path, Buffer.from('not jpeg'))
    await service.prime(join(directory, 'missing.X3F'), jpeg)
    expect(await service.getJpeg(join(directory, 'missing.X3F'), 'preview')).toBeNull()
    expect(spawnCaptureBinary).not.toHaveBeenCalled()
    expect(await service.getJpeg(path, 'preview')).toEqual(jpeg)
    expect(spawnCaptureBinary).toHaveBeenCalledTimes(1)
  })
})
