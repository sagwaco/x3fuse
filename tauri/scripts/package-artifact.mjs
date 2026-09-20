import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tar = process.platform === 'win32'
  ? join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'

/** Stage the complete native application, then ZIP it with the host's archive tool. */
export async function packageArtifact(
  root = appRoot,
  platform = process.platform,
  arch = process.arch
) {
  if (!['darwin', 'win32', 'linux'].includes(platform))
    throw new Error(`Unsupported platform: ${platform}`)
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const release = join(root, 'src-tauri/target/release')
  const resources = join(root, 'src-tauri/resources')
  const windows = platform === 'win32'
  const launcher = windows ? 'exiftool.exe' : 'exiftool'
  if (!(await stat(join(resources, 'exiftool', launcher))).size)
    throw new Error('ExifTool launcher is empty')
  const support = windows ? 'exiftool_files' : 'lib'
  if (!(await stat(join(resources, 'exiftool', support))).isDirectory())
    throw new Error('ExifTool support files are missing')
  const opcodes = await readdir(join(resources, 'opcodes'), { withFileTypes: true })
  if (!opcodes.some((entry) => entry.isFile() && entry.name.includes('_FF_DNG_Opcodelist3_')))
    throw new Error('Opcode data is missing')

  const os = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform]
  const name = `x3fuse-alpha-${os}-${arch}`
  const temporary = await mkdtemp(join(tmpdir(), 'x3fuse-package-'))
  const stage = join(temporary, name)
  const output = join(root, 'artifacts', `${name}.zip`)
  try {
    await mkdir(stage)
    if (platform === 'darwin') {
      const bundle = `${config.productName}.app`
      const source = join(release, 'bundle/macos', bundle)
      // Fail packaging if the app bundle was built before resources were prepared.
      await stat(join(source, 'Contents/MacOS/x3fuse-tauri'))
      await stat(join(source, 'Contents/Resources/resources/exiftool', launcher))
      await stat(join(source, 'Contents/Resources/resources/exiftool/lib'))
      await stat(join(source, 'Contents/Resources/resources/opcodes'))
      if (process.platform === 'darwin') {
        // Preserve the stapled ticket, extended attributes, and bundle symlinks.
        execFileSync('ditto', [source, join(stage, bundle)], { stdio: 'inherit' })
      } else {
        await cp(source, join(stage, bundle), { recursive: true, verbatimSymlinks: true })
      }
    } else {
      const executable = `x3fuse-tauri${windows ? '.exe' : ''}`
      const binaryDir = windows ? stage : join(stage, 'bin')
      const resourceDir = windows ? stage : join(stage, 'lib/x3fuse-tauri')
      await mkdir(binaryDir, { recursive: true })
      await cp(join(release, executable), join(binaryDir, executable))
      await cp(resources, join(resourceDir, 'resources'), { recursive: true, verbatimSymlinks: true })
    }
    await cp(join(root, '../LICENSE'), join(stage, 'LICENSE'))
    const launch =
      platform === 'darwin'
        ? `Open ${config.productName}.app. macOS 14 or newer and system Perl are required.\nApple Silicon (M-series): x3fuse-alpha-macos-arm64.zip\nIntel Mac: x3fuse-alpha-macos-x64.zip\nCheck Apple menu > About This Mac: Chip identifies Apple Silicon; Processor identifies Intel.`
        : windows
          ? 'Run x3fuse-tauri.exe. Microsoft WebView2 Runtime must be installed.'
          : 'Run ./bin/x3fuse-tauri. WebKitGTK 4.1, GTK 3, and Perl must be installed.'
    await writeFile(
      join(stage, 'README.txt'),
      `X3Fuse alpha ${config.version}\n${launch}\nKeep the complete extracted directory together.\nPublished macOS alpha releases are signed and notarized; development builds are not notarized. Windows and Linux builds are unsigned.\nNo automatic updates.\nSource and build instructions: https://github.com/sagwaco/x3fuse/tree/main/tauri\n`
    )
    await mkdir(dirname(output), { recursive: true })
    await rm(output, { force: true })
    if (process.platform === 'darwin') {
      execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stage, output], { stdio: 'inherit' })
    } else if (process.platform === 'win32') {
      execFileSync(tar, ['-a', '-cf', output, '-C', temporary, name], { stdio: 'inherit' })
    } else {
      execFileSync('zip', ['-q', '-r', '-y', output, name], { cwd: temporary, stdio: 'inherit' })
    }
    return output
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await packageArtifact())
}
