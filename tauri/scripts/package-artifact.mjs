import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tar = process.platform === 'win32'
  ? join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'

/** Stage the native executable and all bundled data, then preserve modes in tar. */
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

  const name = `x3fuse-tauri-${platform}-${arch}`
  const temporary = await mkdtemp(join(tmpdir(), 'x3fuse-package-'))
  const stage = join(temporary, name)
  const output = join(root, 'artifacts', `${name}.tar.gz`)
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
      await cp(source, join(stage, bundle), { recursive: true, verbatimSymlinks: true })
    } else {
      const executable = `x3fuse-tauri${windows ? '.exe' : ''}`
      const binaryDir = windows ? stage : join(stage, 'bin')
      const resourceDir = windows ? stage : join(stage, 'lib/x3fuse-tauri')
      await mkdir(binaryDir, { recursive: true })
      await cp(join(release, executable), join(binaryDir, executable))
      await cp(resources, join(resourceDir, 'resources'), { recursive: true })
    }
    await cp(join(root, '../LICENSE'), join(stage, 'LICENSE'))
    const launch =
      platform === 'darwin'
        ? `Open ${config.productName}.app.`
        : windows
          ? 'Run x3fuse-tauri.exe. Microsoft WebView2 Runtime must be installed.'
          : 'Run ./bin/x3fuse-tauri. WebKitGTK 4.1, GTK 3, and Perl must be installed.'
    await writeFile(
      join(stage, 'README.txt'),
      `X3Fuse Tauri ${config.version}\n${launch}\nKeep the complete extracted directory together.\nDevelopment build: no signing, notarization, or auto-updater.\nSource and build instructions: https://github.com/sagwaco/x3fuse/tree/main/tauri\n`
    )
    await mkdir(dirname(output), { recursive: true })
    execFileSync(tar, ['-czf', output, '-C', temporary, name], { stdio: 'inherit' })
    return output
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await packageArtifact())
}
