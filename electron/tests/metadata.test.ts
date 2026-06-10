import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readBasicMetadata } from '../src/main/services/FileMetadata'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'x3f-meta-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readBasicMetadata', () => {
  it('reads file size and the embedded EXIF capture date', async () => {
    const path = join(dir, 'withdate.bin')
    // Simulate an X3F header with an ASCII DateTime somewhere in the first 64KB.
    const payload = Buffer.concat([
      Buffer.from('FOVb....header...'),
      Buffer.from('2021:07:15 09:30:45'),
      Buffer.alloc(1024)
    ])
    await writeFile(path, payload)

    const meta = await readBasicMetadata(path)
    expect(meta.fileSize).toBe(payload.length)
    expect(meta.capturedDate).toBeDefined()
    const d = new Date(meta.capturedDate as string)
    expect(d.getFullYear()).toBe(2021)
    expect(d.getMonth()).toBe(6) // July (0-based)
    expect(d.getDate()).toBe(15)
    expect(d.getHours()).toBe(9)
    expect(d.getMinutes()).toBe(30)
  })

  it('falls back to a filesystem date when no EXIF date is present', async () => {
    const path = join(dir, 'nodate.bin')
    await writeFile(path, Buffer.from('no timestamp here at all'))
    const meta = await readBasicMetadata(path)
    expect(meta.fileSize).toBeGreaterThan(0)
    expect(meta.capturedDate).toBeDefined()
    expect(Number.isNaN(new Date(meta.capturedDate as string).getTime())).toBe(false)
  })
})
