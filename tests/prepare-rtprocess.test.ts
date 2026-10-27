import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { downloadVerified } from '../scripts/download-verified.mjs'
import { commit, kernels, patches, prepareRtprocess } from '../scripts/prepare-rtprocess.mjs'

vi.mock('../scripts/download-verified.mjs', () => ({ downloadVerified: vi.fn() }))

it('prepares patched kernels and notices, reuses them, and preserves them if a patch fails', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'x3fuse rtprocess test-'))
  const root = join(workspace, 'project with spaces')
  const name = `librtprocess-${commit}`
  const source = join(workspace, name)
  const archive = join(workspace, 'fixture.tar.gz')
  const destination = join(root, 'src-tauri/crates/x3f-dng/rtprocess')
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  const pack = () => execFileSync(tar, ['-czf', archive, '-C', workspace, name])
  const download = vi.mocked(downloadVerified)
  const copyArchive = async (_url: string, path: string) => {
    await cp(archive, path)
  }
  try {
    await mkdir(join(source, 'src/include'), { recursive: true })
    await mkdir(join(source, 'src/demosaic'), { recursive: true })
    await writeFile(join(source, 'src/include/librtprocess.h'), 'header')
    await writeFile(join(source, 'LICENSE.txt'), 'upstream license')
    await writeFile(join(source, 'README.md'), 'upstream readme')
    for (const kernel of kernels) {
      const snippets = patches
        .filter(([file]: [string]) => file === `${kernel}.cc`)
        .map(([, from, , count]: [string, string, string, number]) => `${from}\n`.repeat(count))
      await writeFile(join(source, `src/demosaic/${kernel}.cc`), snippets.join('\n'))
    }
    pack()
    download.mockImplementation(copyArchive)
    await prepareRtprocess(root)
    expect(download).toHaveBeenCalledWith(
      `https://github.com/CarVac/librtprocess/archive/${commit}.tar.gz`,
      join(root, `.cache/${name}.tar.gz`),
      'a85bac0d67fc08ceaf61a7deeedff5ffaf8edabcebeb9a59924df378efc800f6'
    )
    expect(await readFile(join(destination, 'LICENSE.txt'), 'utf8')).toBe('upstream license')
    for (const kernel of kernels.filter((k: string) => k !== 'border')) {
      expect(await readFile(join(destination, `demosaic/${kernel}.cc`), 'utf8')).toMatch(
        /^\/\/ Modified for X3Fuse .*2026-10-26:/
      )
    }
    const amazePath = join(destination, 'demosaic/amaze.cc')
    const amaze = await readFile(amazePath, 'utf8')
    expect(amaze.match(/indx < rr \* ts \+ cc1 - 16\)/g)).toHaveLength(4)
    expect(amaze).toContain('if (setProgCancel(progress)) goto x3f_cancel;')
    const marker = await readFile(join(destination, '.version'), 'utf8')
    download.mockClear().mockRejectedValue(new Error('offline'))
    await prepareRtprocess(root)
    expect(download).not.toHaveBeenCalled()

    await writeFile(join(destination, '.version'), 'old version')
    const ahdPath = join(source, 'src/demosaic/ahd.cc')
    const ahd = await readFile(ahdPath, 'utf8')
    await writeFile(ahdPath, ahd.replace('setProgCancel(progress);', 'changed upstream call;'))
    pack()
    download.mockImplementation(copyArchive)
    await expect(prepareRtprocess(root)).rejects.toThrow('matched 0 times, expected 1')
    expect(await readFile(amazePath, 'utf8')).toBe(amaze)
    expect(await readFile(join(destination, '.version'), 'utf8')).toBe('old version')
    expect(await readdir(join(root, '.cache'))).toEqual([`${name}.tar.gz`])

    await writeFile(ahdPath, ahd)
    pack()
    await prepareRtprocess(root)
    expect(await readFile(join(destination, '.version'), 'utf8')).toBe(marker)
  } finally {
    download.mockReset()
    await rm(workspace, { recursive: true, force: true })
  }
})
