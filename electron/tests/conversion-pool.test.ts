import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import type { ChildProcess } from 'child_process'
import type { RunResult } from '../src/main/services/ProcessRunner'
import { spawnCapture } from '../src/main/services/ProcessRunner'
import { runWithConcurrency } from '../src/main/services/concurrency'
import { ConversionService } from '../src/main/services/ConversionService'
import { createCollectingSink } from '../src/main/services/events'
import type { BinaryResolver } from '../src/main/services/BinaryResolver'
import type { ExifService } from '../src/main/services/ExifService'
import { DEFAULT_SETTINGS, type ConversionSettings } from '@shared/types'

vi.mock('../src/main/services/ProcessRunner', () => ({ spawnCapture: vi.fn() }))
// Real pool behavior by default; individual tests can force a pool-level failure.
vi.mock('../src/main/services/concurrency', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/services/concurrency')>()
  return { ...actual, runWithConcurrency: vi.fn(actual.runWithConcurrency) }
})

/**
 * Pool behavior of ConversionService with a mocked x3f_extract: spawnCapture
 * returns controllable fakes whose exits the tests resolve by hand, while the
 * output dir / validation / rename steps run against a real temp dir.
 */

interface FakeChild {
  pid: number
  killed: boolean
  kills: string[]
  kill(signal?: string): boolean
}

interface FakeSpawn {
  inputPath: string
  cwd: string | undefined
  child: FakeChild
  exit(result: Partial<RunResult>): void
}

const spawns: FakeSpawn[] = []

function installFakeSpawn(): void {
  vi.mocked(spawnCapture).mockImplementation((_command, args, opts) => {
    const child: FakeChild = {
      pid: 1000 + spawns.length,
      killed: false,
      kills: [],
      kill(signal = 'SIGTERM') {
        this.kills.push(signal)
        this.killed = true
        return true
      }
    }
    let resolve!: (r: RunResult) => void
    const result = new Promise<RunResult>((r) => {
      resolve = r
    })
    spawns.push({
      // buildX3FArgs puts the input path last.
      inputPath: args[args.length - 1],
      cwd: opts?.cwd,
      child,
      exit: (r) => resolve({ code: 0, signal: null, stdout: '', stderr: '', ...r })
    })
    return { child: child as unknown as ChildProcess, result }
  })
}

async function until(cond: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function tick(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

/** Write the intermediate "<name>.X3F.dng" x3f_extract would have produced. */
async function writeIntermediate(outputDir: string, inputPath: string): Promise<void> {
  await writeFile(join(outputDir, `${basename(inputPath)}.dng`), 'fake-dng')
}

function makeService(): { service: ConversionService; sink: ReturnType<typeof createCollectingSink> } {
  const resolver = {
    x3fExtractPath: () => process.execPath, // any existing path
    opcodesDir: () => null
  } as unknown as BinaryResolver
  const exif = {
    extract: async () => ({ raw: {} }),
    copyAllTags: async () => {}
  } as unknown as ExifService
  const sink = createCollectingSink()
  return { service: new ConversionService(resolver, exif, sink), sink }
}

function statusesFor(sink: ReturnType<typeof createCollectingSink>, id: string): string[] {
  return sink.events
    .filter((e) => e.channel === 'file:status')
    .map((e) => e.payload as { id: string; status: string })
    .filter((p) => p.id === id)
    .map((p) => p.status)
}

describe('ConversionService pool', () => {
  let outDir: string

  beforeEach(async () => {
    spawns.length = 0
    installFakeSpawn()
    outDir = await mkdtemp(join(tmpdir(), 'x3f-pool-'))
  })

  afterEach(async () => {
    delete process.env.X3FUSE_CONCURRENCY
    vi.mocked(spawnCapture).mockReset()
    await rm(outDir, { recursive: true, force: true })
  })

  function settings(): ConversionSettings {
    return { ...DEFAULT_SETTINGS, outputFormat: 'dng', outputDirectory: outDir }
  }

  it('runs at most X3FUSE_CONCURRENCY conversions at once', async () => {
    process.env.X3FUSE_CONCURRENCY = '2'
    const files = [0, 1, 2, 3].map((i) => ({ id: `f${i}`, path: `/in/IMG000${i}.X3F` }))
    const { service } = makeService()
    const run = service.convert(files, settings())

    await until(() => spawns.length === 2, 'first two spawns')
    await tick()
    expect(spawns.length).toBe(2) // third waits for a free lane

    await writeIntermediate(outDir, spawns[0].inputPath)
    spawns[0].exit({})
    await until(() => spawns.length === 3, 'third spawn')
    await tick()
    expect(spawns.length).toBe(3)

    for (const s of spawns.slice(1)) {
      await writeIntermediate(outDir, s.inputPath)
      s.exit({})
    }
    await until(() => spawns.length === 4, 'fourth spawn')
    await writeIntermediate(outDir, spawns[3].inputPath)
    spawns[3].exit({})

    const result = await run
    expect(result).toMatchObject({ completed: 4, failed: 0, total: 4 })
  })

  it('stop() kills every live child and rolls in-flight files back to queued', async () => {
    process.env.X3FUSE_CONCURRENCY = '2'
    const files = [0, 1, 2].map((i) => ({ id: `f${i}`, path: `/in/IMG000${i}.X3F` }))
    const { service, sink } = makeService()
    const run = service.convert(files, settings())

    await until(() => spawns.length === 2, 'two spawns')
    service.stop()
    expect(spawns[0].child.kills).toContain('SIGTERM')
    expect(spawns[1].child.kills).toContain('SIGTERM')

    spawns[0].exit({ code: null, signal: 'SIGTERM' })
    spawns[1].exit({ code: null, signal: 'SIGTERM' })
    const result = await run

    expect(spawns.length).toBe(2) // third file never spawned
    expect(result).toMatchObject({ completed: 0, failed: 0, total: 3 })
    expect(statusesFor(sink, 'f0').at(-1)).toBe('queued')
    expect(statusesFor(sink, 'f1').at(-1)).toBe('queued')
    expect(statusesFor(sink, 'f2')).toEqual([]) // never started
    const batches = sink.events.filter((e) => e.channel === 'batch:complete')
    expect(batches).toHaveLength(1)
  })

  it('one failing file does not abort the others', async () => {
    process.env.X3FUSE_CONCURRENCY = '3'
    const files = [0, 1, 2].map((i) => ({ id: `f${i}`, path: `/in/IMG000${i}.X3F` }))
    const { service, sink } = makeService()
    const run = service.convert(files, settings())

    await until(() => spawns.length === 3, 'three spawns')
    // Lanes spawn in whatever order their pre-steps resolve, so match by input
    // path rather than spawn index.
    const spawnFor = (name: string): FakeSpawn => {
      const s = spawns.find((sp) => basename(sp.inputPath) === name)
      if (!s) throw new Error(`no spawn for ${name}`)
      return s
    }
    await writeIntermediate(outDir, spawnFor('IMG0000.X3F').inputPath)
    spawnFor('IMG0000.X3F').exit({})
    spawnFor('IMG0001.X3F').exit({ code: 1, stderr: 'boom' })
    await writeIntermediate(outDir, spawnFor('IMG0002.X3F').inputPath)
    spawnFor('IMG0002.X3F').exit({})

    const result = await run
    expect(result).toMatchObject({ completed: 2, failed: 1, total: 3 })
    expect(statusesFor(sink, 'f1').at(-1)).toBe('failed')
    const failure = sink.events
      .map((e) => e.payload as { id: string; message?: string })
      .find((p) => p.id === 'f1' && p.message)
    expect(failure?.message).toContain('boom')
    expect(statusesFor(sink, 'f0').at(-1)).toBe('completed')
    expect(statusesFor(sink, 'f2').at(-1)).toBe('completed')
  })

  it('honors the concurrency setting when no env override is set', async () => {
    const files = [0, 1].map((i) => ({ id: `f${i}`, path: `/in/IMG000${i}.X3F` }))
    const { service } = makeService()
    const run = service.convert(files, { ...settings(), concurrency: 1 })

    await until(() => spawns.length === 1, 'first spawn')
    await tick()
    expect(spawns.length).toBe(1) // manual setting of 1 keeps it serial

    await writeIntermediate(outDir, spawns[0].inputPath)
    spawns[0].exit({})
    await until(() => spawns.length === 2, 'second spawn')
    await writeIntermediate(outDir, spawns[1].inputPath)
    spawns[1].exit({})

    const result = await run
    expect(result).toMatchObject({ completed: 2, failed: 0, total: 2 })
  })

  it('removes the partial intermediate output when a conversion is cancelled', async () => {
    process.env.X3FUSE_CONCURRENCY = '1'
    const file = { id: 'f0', path: '/in/IMG0000.X3F' }
    const { service, sink } = makeService()
    const run = service.convert([file], settings())

    await until(() => spawns.length === 1, 'spawn')
    // x3f_extract wrote (part of) its output before being killed.
    await writeIntermediate(outDir, spawns[0].inputPath)
    const intermediate = join(outDir, `${basename(file.path)}.dng`)
    service.stop()
    spawns[0].exit({ code: null, signal: 'SIGTERM' })
    await run

    expect(statusesFor(sink, 'f0').at(-1)).toBe('queued')
    expect(existsSync(intermediate)).toBe(false)
  })

  it('rejects a second convert() while one is running', async () => {
    process.env.X3FUSE_CONCURRENCY = '1'
    const { service, sink } = makeService()
    const run = service.convert([{ id: 'f0', path: '/in/IMG0000.X3F' }], settings())

    await until(() => spawns.length === 1, 'first spawn')
    await expect(
      service.convert([{ id: 'g0', path: '/in/IMG0009.X3F' }], settings())
    ).rejects.toThrow('already running')

    await writeIntermediate(outDir, spawns[0].inputPath)
    spawns[0].exit({})
    await run
    // The refused call must not have emitted a second batch:complete.
    const batches = sink.events.filter((e) => e.channel === 'batch:complete')
    expect(batches).toHaveLength(1)
  })

  it('emits batch:complete even when the worker pool itself rejects', async () => {
    const { service, sink } = makeService()
    vi.mocked(runWithConcurrency).mockRejectedValueOnce(new Error('pool blew up'))

    await expect(
      service.convert([{ id: 'f0', path: '/in/IMG0000.X3F' }], settings())
    ).rejects.toThrow('pool blew up')
    expect(sink.events.filter((e) => e.channel === 'batch:complete')).toHaveLength(1)
    expect(service.isRunning).toBe(false)
  })

  it('serializes files that share an output target', async () => {
    process.env.X3FUSE_CONCURRENCY = '2'
    // Same basename, different source dirs, same output dir -> same target.
    const files = [
      { id: 'a', path: '/one/IMG0001.X3F' },
      { id: 'b', path: '/two/IMG0001.X3F' }
    ]
    const { service } = makeService()
    const run = service.convert(files, settings())

    await until(() => spawns.length === 1, 'first spawn')
    await tick()
    expect(spawns.length).toBe(1) // collision group runs serially

    await writeIntermediate(outDir, spawns[0].inputPath)
    spawns[0].exit({})
    await until(() => spawns.length === 2, 'second spawn')
    await writeIntermediate(outDir, spawns[1].inputPath)
    spawns[1].exit({})

    const result = await run
    expect(result).toMatchObject({ completed: 2, failed: 0, total: 2 })
  })
})
