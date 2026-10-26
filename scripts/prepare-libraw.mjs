import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { downloadVerified } from './download-verified.mjs'

const version = '0.22.2'
const sha256 = 'de86b035655accff8d4010f1a221fdf50d353cb7b1422ba26f14a0db92612cfa'
const marker = `${version}:${sha256}`

export async function prepareLibraw(root) {
  const destination = join(root, 'src-tauri/crates/x3f-dng/libraw')
  if (
    (await readFile(join(destination, '.version'), 'utf8').catch(() => '')) === marker &&
    existsSync(join(destination, 'libraw/libraw.h'))
  )
    return

  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  const archive = `LibRaw-${version}.tar.gz`
  const archivePath = join(cache, archive)
  await downloadVerified(`https://www.libraw.org/data/${archive}`, archivePath, sha256)
  const temporary = await mkdtemp(join(cache, 'libraw-'))
  try {
    const tar =
      process.platform === 'win32'
        ? join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
    execFileSync(tar, ['-xf', archivePath, '-C', temporary], { stdio: 'inherit' })
    const source = join(temporary, `LibRaw-${version}`)
    const prepared = join(temporary, 'prepared')
    await mkdir(prepared)
    for (const name of [
      'src',
      'internal',
      'libraw',
      'README.md',
      'COPYRIGHT',
      'LICENSE.LGPL',
      'LICENSE.CDDL'
    ]) {
      await cp(join(source, name), join(prepared, name), { recursive: true })
    }
    // Keep the source subset used before the download step was added.
    for (const name of [
      'Makefile',
      'preprocessing/preprocessing_ph.cpp',
      'postprocessing/postprocessing_ph.cpp',
      'write/write_ph.cpp'
    ]) {
      await rm(join(prepared, 'src', name))
    }
    await writeFile(join(prepared, '.version'), marker)
    await mkdir(join(destination, '..'), { recursive: true })
    await rm(destination, { recursive: true, force: true })
    await rename(prepared, destination)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
