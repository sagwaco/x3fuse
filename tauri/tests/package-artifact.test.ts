import { chmod, lstat, mkdtemp, mkdir, writeFile, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'
import { packageArtifact } from '../scripts/package-artifact.mjs'

it('creates fresh ZIPs with complete native layouts, launch instructions, and Unix modes/links', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'x3fuse artifact test-'))
  const root = join(workspace, 'tauri')
  const windows = process.platform === 'win32'
  const tar = windows
    ? join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
  const previousPath = process.env.PATH
  const entriesIn = (archive: string): string =>
    process.platform === 'linux'
      ? execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
      : execFileSync(tar, ['-tf', archive], { encoding: 'utf8' })
  async function file(path: string, content = 'fixture'): Promise<void> {
    const location = join(root, path)
    await mkdir(join(location, '..'), { recursive: true })
    await writeFile(location, content)
  }
  try {
    if (windows) {
      // A PATH-resolved tar must fail; packaging must use Windows' system tar.
      await writeFile(join(workspace, 'tar.exe'), 'not an executable')
      process.env.PATH = `${workspace}${delimiter}${previousPath ?? ''}`
    }
    await writeFile(join(workspace, 'LICENSE'), 'license fixture')
    await file(
      'src-tauri/tauri.conf.json',
      JSON.stringify({ productName: 'X3Fuse Tauri', version: '0.1.0' })
    )
    await file('src-tauri/resources/exiftool/exiftool')
    await file('src-tauri/resources/exiftool/exiftool.exe')
    await file('src-tauri/resources/exiftool/lib/Image/ExifTool.pm')
    await file('src-tauri/resources/exiftool/exiftool_files/perl532.dll')
    const opcode = 'DP2M_FF_DNG_Opcodelist3_5.6'
    await file(`src-tauri/resources/opcodes/${opcode}`)
    await file('src-tauri/target/release/x3fuse-tauri')
    await file('src-tauri/target/release/x3fuse-tauri.exe')
    const mac = 'src-tauri/target/release/bundle/macos/X3Fuse Tauri.app/Contents'
    await file(`${mac}/MacOS/x3fuse-tauri`)
    await file(`${mac}/Resources/resources/exiftool/exiftool`)
    await file(`${mac}/Resources/resources/exiftool/lib/Image/ExifTool.pm`)
    await file(`${mac}/Resources/resources/opcodes/${opcode}`)
    if (!windows) {
      await chmod(join(root, 'src-tauri/target/release/x3fuse-tauri'), 0o755)
      await chmod(join(root, mac, 'MacOS/x3fuse-tauri'), 0o755)
      await symlink(opcode, join(root, 'src-tauri/resources/opcodes/current'))
      await symlink(opcode, join(root, mac, 'Resources/resources/opcodes/current'))
    }
    for (const [platform, os, arch] of [
      ['darwin', 'macos', 'arm64'],
      ['darwin', 'macos', 'x64'],
      ['win32', 'windows', 'x64'],
      ['linux', 'linux', 'x64']
    ]) {
      const sourceResources = platform === 'darwin' ? `${mac}/Resources/resources` : 'src-tauri/resources'
      await file(`${sourceResources}/obsolete.txt`)
      const archive = await packageArtifact(root, platform, arch)
      const name = `x3fuse-alpha-${os}-${arch}`
      expect(archive).toBe(join(root, 'artifacts', `${name}.zip`))
      expect((await readFile(archive)).subarray(0, 4).toString('hex')).toBe('504b0304')
      const entries = entriesIn(archive)
      const prefix = `${name}/`
      const binary =
        platform === 'darwin'
          ? 'X3Fuse Tauri.app/Contents/MacOS/x3fuse-tauri'
          : platform === 'win32'
            ? 'x3fuse-tauri.exe'
            : 'bin/x3fuse-tauri'
      const resources =
        platform === 'darwin'
          ? 'X3Fuse Tauri.app/Contents/Resources/resources/'
          : platform === 'win32'
            ? 'resources/'
            : 'lib/x3fuse-tauri/resources/'
      expect(entries).toContain(prefix + binary)
      expect(entries).toContain(prefix + resources + `opcodes/${opcode}`)
      expect(entries).toContain(
        prefix + resources + 'exiftool/' + (platform === 'win32' ? 'exiftool.exe' : 'exiftool')
      )
      expect(entries).toContain(
        prefix +
          resources +
          'exiftool/' +
          (platform === 'win32' ? 'exiftool_files/perl532.dll' : 'lib/Image/ExifTool.pm')
      )
      expect(entries).toContain(prefix + 'LICENSE')
      expect(entries).toContain(prefix + resources + 'obsolete.txt')

      const extracted = join(workspace, name)
      await mkdir(extracted)
      if (process.platform === 'darwin') {
        execFileSync('ditto', ['-x', '-k', archive, extracted])
      } else if (windows) {
        execFileSync(tar, ['-xf', archive, '-C', extracted])
      } else {
        execFileSync('unzip', ['-q', archive, '-d', extracted])
      }
      const readme = await readFile(join(extracted, name, 'README.txt'), 'utf8')
      expect(readme).toContain('X3Fuse alpha 0.1.0')
      expect(readme).toContain('No automatic updates.')
      if (platform === 'darwin') {
        expect(readme).toContain('Apple Silicon (M-series): x3fuse-alpha-macos-arm64.zip')
        expect(readme).toContain('Intel Mac: x3fuse-alpha-macos-x64.zip')
        expect(readme).toContain('About This Mac')
      }
      if (!windows && platform !== 'win32') {
        expect((await lstat(join(extracted, name, binary))).mode & 0o777).toBe(0o755)
        expect(await readlink(join(extracted, name, resources, 'opcodes/current'))).toBe(opcode)
      }

      await rm(join(root, sourceResources, 'obsolete.txt'))
      expect(await packageArtifact(root, platform, arch)).toBe(archive)
      expect(entriesIn(archive)).not.toContain('obsolete.txt')
    }
    await rm(join(root, 'src-tauri/resources/opcodes', opcode))
    await mkdir(join(root, 'src-tauri/resources/opcodes', opcode))
    await expect(packageArtifact(root, 'linux', 'x64')).rejects.toThrow('Opcode data is missing')
    await rm(join(root, 'src-tauri/resources/exiftool/lib'), { recursive: true })
    await expect(packageArtifact(root, 'linux', 'x64')).rejects.toThrow()
  } finally {
    if (windows) {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
    await rm(workspace, { recursive: true, force: true })
  }
})
