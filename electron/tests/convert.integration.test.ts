import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { BinaryResolver } from '../src/main/services/BinaryResolver'
import { ExifService } from '../src/main/services/ExifService'
import { ConversionService } from '../src/main/services/ConversionService'
import { createCollectingSink } from '../src/main/services/events'
import { DEFAULT_SETTINGS, type ConversionSettings } from '@shared/types'

/**
 * Real, end-to-end conversion against the bundled x3f_extract + exiftool and
 * the sample X3F files in ../x3fuse-core/temp. Gated behind X3FUSE_INTEGRATION
 * so the default `vitest run` stays fast and binary-free.
 *
 *   npm run test:integration
 */
const here = dirname(fileURLToPath(import.meta.url))
const electronRoot = resolve(here, '..')
const resourcesRoot = resolve(electronRoot, 'resources')
const sampleDir = resolve(electronRoot, '..', '..', 'x3fuse-core', 'temp')

const SAMPLES = {
  merrill: join(sampleDir, 'DP2M0981.X3F'),
  quattro: join(sampleDir, 'DP0Q0010.X3F')
}

const ready =
  process.env.X3FUSE_INTEGRATION === '1' &&
  existsSync(join(resourcesRoot, 'opcodes')) &&
  existsSync(SAMPLES.merrill) &&
  existsSync(SAMPLES.quattro)

// Little-endian TIFF/DNG magic: "II" 0x2A 0x00.
function isTiffDng(buf: Buffer): boolean {
  return (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  )
}

function makeService(sink = createCollectingSink()): {
  service: ConversionService
  sink: ReturnType<typeof createCollectingSink>
} {
  const resolver = new BinaryResolver(resourcesRoot)
  const exif = new ExifService(resolver)
  return { service: new ConversionService(resolver, exif, sink), sink }
}

describe.skipIf(!ready)('ConversionService (integration)', () => {
  let outDir: string

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'x3f-convert-'))
    // Sanity: resolver should report no setup issues.
    expect(new BinaryResolver(resourcesRoot).validate()).toEqual([])
  })
  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  it(
    'converts a Merrill X3F to a valid DNG and renames .X3F.dng -> .dng',
    async () => {
      const dest = join(outDir, 'merrill')
      const { service, sink } = makeService()
      const settings: ConversionSettings = {
        ...DEFAULT_SETTINGS,
        outputFormat: 'dng',
        outputDirectory: dest,
        denoiseIntensity: 0 // skip the slow NLM pass for a faster test
      }

      const result = await service.convert([{ id: 'm1', path: SAMPLES.merrill }], settings)
      expect(result).toMatchObject({ completed: 1, failed: 0, total: 1 })

      const finalDng = join(dest, 'DP2M0981.dng')
      const intermediate = join(dest, 'DP2M0981.X3F.dng')
      expect(existsSync(finalDng)).toBe(true)
      expect(existsSync(intermediate)).toBe(false) // renamed away

      const buf = await readFile(finalDng)
      expect(buf.length).toBeGreaterThan(0)
      expect(isTiffDng(buf)).toBe(true)

      // Status events: processing -> completed, progress reaches 1.0.
      const statuses = sink.events
        .filter((e) => e.channel === 'file:status')
        .map((e) => (e.payload as { status: string }).status)
      expect(statuses).toContain('processing')
      expect(statuses).toContain('completed')
      const maxProgress = Math.max(
        ...sink.events
          .filter((e) => e.channel === 'file:progress')
          .map((e) => (e.payload as { progress: number }).progress)
      )
      expect(maxProgress).toBe(1)
    },
    180_000
  )

  it(
    'converts a Quattro X3F to TIFF, keeping the .X3F.tif name (no DNG rename)',
    async () => {
      const dest = join(outDir, 'quattro')
      const { service } = makeService()
      const settings: ConversionSettings = {
        ...DEFAULT_SETTINGS,
        outputFormat: 'tiff',
        outputDirectory: dest,
        denoiseIntensity: 0
      }

      const result = await service.convert([{ id: 'q1', path: SAMPLES.quattro }], settings)
      expect(result).toMatchObject({ completed: 1, failed: 0 })

      const tif = join(dest, 'DP0Q0010.X3F.tif')
      expect(existsSync(tif)).toBe(true)
      const info = await stat(tif)
      expect(info.size).toBeGreaterThan(0)
    },
    180_000
  )

  it(
    'converts a batch of files concurrently',
    async () => {
      const dest = join(outDir, 'batch')
      const { service, sink } = makeService()
      const settings: ConversionSettings = {
        ...DEFAULT_SETTINGS,
        outputFormat: 'dng',
        outputDirectory: dest,
        denoiseIntensity: 0
      }

      const result = await service.convert(
        [
          { id: 'm1', path: SAMPLES.merrill },
          { id: 'q1', path: SAMPLES.quattro }
        ],
        settings
      )
      expect(result).toMatchObject({ completed: 2, failed: 0, total: 2 })

      for (const name of ['DP2M0981.dng', 'DP0Q0010.dng']) {
        const buf = await readFile(join(dest, name))
        expect(isTiffDng(buf)).toBe(true)
      }
      const completed = sink.events
        .filter((e) => e.channel === 'file:status')
        .map((e) => e.payload as { id: string; status: string })
        .filter((p) => p.status === 'completed')
        .map((p) => p.id)
      expect(completed.sort()).toEqual(['m1', 'q1'])
    },
    360_000
  )

  it('reports a failure (not a throw) for a non-existent input', async () => {
    const { service } = makeService()
    const result = await service.convert(
      [{ id: 'bad', path: join(outDir, 'does-not-exist.X3F') }],
      { ...DEFAULT_SETTINGS, outputDirectory: join(outDir, 'bad'), denoiseIntensity: 0 }
    )
    expect(result.failed).toBe(1)
    expect(result.completed).toBe(0)
  })
})
