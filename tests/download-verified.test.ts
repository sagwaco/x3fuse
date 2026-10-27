import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { downloadVerified } from '../scripts/download-verified.mjs'

let root: string
const bytes = Buffer.from('verified archive fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const url = 'https://example.com/archive.tar.gz'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x3fuse download-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

it('reuses verified bytes without network access', async () => {
  const archive = join(root, 'archive.tar.gz')
  await writeFile(archive, bytes)
  const fetch = vi.fn().mockRejectedValue(new Error('offline'))
  vi.stubGlobal('fetch', fetch)
  await downloadVerified(url, archive, sha256)
  expect(fetch).not.toHaveBeenCalled()
})

it('replaces a corrupt cache after a transient download failure', async () => {
  const archive = join(root, 'archive.tar.gz')
  await writeFile(archive, 'corrupt cache')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(new Response(bytes))
  vi.stubGlobal('fetch', fetch)
  await downloadVerified(url, archive, sha256)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(await readFile(archive)).toEqual(bytes)
})

it('rejects a checksum mismatch without caching the download', async () => {
  const archive = join(root, 'archive.tar.gz')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('wrong bytes')))
  await expect(downloadVerified(url, archive, sha256)).rejects.toThrow('checksum mismatch')
  await expect(readFile(archive)).rejects.toThrow()
})

it('stops after three failed attempts without creating an archive', async () => {
  const archive = join(root, 'archive.tar.gz')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const fetch = vi.fn().mockRejectedValue(new Error('offline'))
  vi.stubGlobal('fetch', fetch)
  await expect(downloadVerified(url, archive, sha256)).rejects.toThrow('offline')
  expect(fetch).toHaveBeenCalledTimes(3)
  await expect(readFile(archive)).rejects.toThrow()
})
