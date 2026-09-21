import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resources = join(root, 'src-tauri/resources')
const version = '13.59'
const windows = process.platform === 'win32'
const tar = windows
  ? join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'
const archive = windows ? `exiftool-${version}_64.zip` : `Image-ExifTool-${version}.tar.gz`
// Published at https://downloads.sourceforge.net/project/exiftool/checksums-13.59.txt
const sha256 = windows
  ? '44b512b25af500724ba579d0a53c8fc5851628b692dd5e5d94ae4a15c2cba9ec'
  : '668ea3acececb7235fbd0f4900e72d5f12c9b07e5c778fd36cb1e9b5828fd65a'
const marker = `${process.platform}:${version}:${sha256}`
const destination = join(resources, 'exiftool')
await mkdir(resources, { recursive: true })
await cp(join(root, '../X3Fuse/opcodes'), join(resources, 'opcodes'), { recursive: true })
const coreNotices = join(resources, 'licenses/x3fuse-core')
await mkdir(coreNotices, { recursive: true })
for (const name of ['LICENSE', 'NOTICE']) {
  await cp(join(root, 'licenses/x3fuse-core', name), join(coreNotices, name))
}
await cp(join(root, '../LICENSE'), join(resources, 'licenses/X3Fuse-LICENSE'))
const renderer = resolve(root, '../../x3fuse-core/crates/x3f-render')
await cp(join(renderer, 'licenses'), join(resources, 'licenses/x3f-render'), { recursive: true })
await cp(join(renderer, 'NOTICE'), join(resources, 'licenses/x3f-render/NOTICE'))

if (await readFile(join(destination, '.version'), 'utf8').catch(() => '') !== marker) {
  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  const archivePath = join(cache, archive)
  let bytes = await readFile(archivePath).catch(() => null)
  const hash = (data) => createHash('sha256').update(data).digest('hex')
  if (!bytes || hash(bytes) !== sha256) {
    console.log(`Downloading ExifTool ${version} (${process.platform})`)
    const response = await fetch(`https://downloads.sourceforge.net/project/exiftool/${archive}`)
    if (!response.ok) throw new Error(`ExifTool download: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (hash(bytes) !== sha256) throw new Error('ExifTool checksum mismatch')
    await writeFile(archivePath, bytes)
  }
  const temporary = await mkdtemp(join(cache, 'exiftool-'))
  try {
    execFileSync(tar, ['-xf', archivePath, '-C', temporary], { stdio: 'inherit' })
    async function findLauncher(dir) {
      const entries = await readdir(dir, { withFileTypes: true })
      const launcher = entries.find((e) => e.isFile() && ['exiftool', 'exiftool(-k).exe', 'exiftool.exe'].includes(e.name))
      if (launcher) return { directory: dir, launcher: launcher.name }
      for (const entry of entries.filter((e) => e.isDirectory())) {
        const found = await findLauncher(join(dir, entry.name))
        if (found) return found
      }
      return null
    }
    const found = await findLauncher(temporary)
    if (!found) throw new Error('ExifTool archive does not contain its launcher')
    await rm(destination, { recursive: true, force: true })
    await cp(found.directory, destination, { recursive: true })
    if (windows && found.launcher !== 'exiftool.exe') await rename(join(destination, found.launcher), join(destination, 'exiftool.exe'))
    if (windows && !existsSync(join(destination, 'exiftool_files'))) throw new Error('Missing Windows ExifTool runtime')
    await writeFile(join(destination, '.version'), marker)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
// ExifTool's test fixtures include unsigned Mach-O files that prevent notarization.
await rm(join(destination, 't'), { recursive: true, force: true })
const executable = windows ? join(destination, 'exiftool.exe') : 'perl'
const args = windows ? ['-ver'] : [join(destination, 'exiftool'), '-ver']
const actual = execFileSync(executable, args, { encoding: 'utf8' }).trim()
if (actual !== version) throw new Error(`Expected ExifTool ${version}, found ${actual}`)
console.log(`Resources ready: ExifTool ${actual}, opcodes`)
