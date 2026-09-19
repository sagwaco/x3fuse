import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'
import { packageArtifact } from '../scripts/package-artifact.mjs'

it('archives each native layout with its executable, complete resources, and license', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'x3fuse artifact test-'))
  const root = join(workspace, 'tauri')
  const windows = process.platform === 'win32'
  const tar = windows
    ? join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
  const previousPath = process.env.PATH
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
    for (const platform of ['darwin', 'win32', 'linux']) {
      const archive = await packageArtifact(root, platform, 'x64')
      const entries = execFileSync(tar, ['-tzf', archive], { encoding: 'utf8' })
      const prefix = `x3fuse-tauri-${platform}-x64/`
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
      expect((await readFile(archive)).length).toBeGreaterThan(0)
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
