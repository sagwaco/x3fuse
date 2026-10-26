import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { downloadVerified } from '../scripts/download-verified.mjs'
import { prepareLibraw } from '../scripts/prepare-libraw.mjs'

vi.mock('../scripts/download-verified.mjs', () => ({ downloadVerified: vi.fn() }))

it('prepares the source subset and notices, reuses it, and preserves it on a failed update', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'x3fuse LibRaw test-'))
  const root = join(workspace, 'project with spaces')
  const fixture = join(workspace, 'LibRaw-0.22.2')
  const archive = join(workspace, 'fixture.tar.gz')
  const destination = join(root, 'src-tauri/crates/x3f-dng/libraw')
  const kept = [
    'src/libraw_c_api.cpp',
    'internal/defines.h',
    'libraw/libraw.h',
    'README.md',
    'COPYRIGHT',
    'LICENSE.LGPL',
    'LICENSE.CDDL'
  ]
  const omitted = [
    'src/Makefile',
    'src/preprocessing/preprocessing_ph.cpp',
    'src/postprocessing/postprocessing_ph.cpp',
    'src/write/write_ph.cpp'
  ]
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  const pack = () => execFileSync(tar, ['-czf', archive, '-C', workspace, 'LibRaw-0.22.2'])
  const download = vi.mocked(downloadVerified)
  const copyArchive = async (_url: string, path: string) => {
    await cp(archive, path)
  }
  try {
    for (const path of [...kept, ...omitted, 'samples/example.cpp']) {
      await mkdir(dirname(join(fixture, path)), { recursive: true })
      await writeFile(join(fixture, path), path)
    }
    pack()
    download.mockImplementation(copyArchive)
    await prepareLibraw(root)
    expect(download).toHaveBeenCalledWith(
      'https://www.libraw.org/data/LibRaw-0.22.2.tar.gz',
      join(root, '.cache/LibRaw-0.22.2.tar.gz'),
      'de86b035655accff8d4010f1a221fdf50d353cb7b1422ba26f14a0db92612cfa'
    )
    for (const path of kept) expect(await readFile(join(destination, path), 'utf8')).toBe(path)
    for (const path of [...omitted, 'samples/example.cpp']) {
      await expect(readFile(join(destination, path))).rejects.toThrow()
    }
    const marker = await readFile(join(destination, '.version'), 'utf8')
    download.mockClear().mockRejectedValue(new Error('offline'))
    await prepareLibraw(root)
    expect(download).not.toHaveBeenCalled()

    await rm(join(destination, 'libraw/libraw.h'))
    download.mockImplementation(copyArchive)
    await prepareLibraw(root)
    expect(await readFile(join(destination, 'libraw/libraw.h'), 'utf8')).toBe('libraw/libraw.h')

    await writeFile(join(destination, '.version'), 'old version')
    await rm(join(fixture, 'COPYRIGHT'))
    pack()
    await expect(prepareLibraw(root)).rejects.toThrow()
    expect(await readFile(join(destination, 'COPYRIGHT'), 'utf8')).toBe('COPYRIGHT')
    expect(await readFile(join(destination, '.version'), 'utf8')).toBe('old version')
    expect(await readdir(join(root, '.cache'))).toEqual(['LibRaw-0.22.2.tar.gz'])

    await writeFile(join(fixture, 'COPYRIGHT'), 'COPYRIGHT')
    pack()
    await prepareLibraw(root)
    expect(await readFile(join(destination, '.version'), 'utf8')).toBe(marker)
  } finally {
    download.mockReset()
    await rm(workspace, { recursive: true, force: true })
  }
})
