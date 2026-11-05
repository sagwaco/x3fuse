// Builds the Quick Look thumbnail and preview extensions into
// src-tauri/target/quicklook. Tauri runs it before it makes the macOS bundle.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src-tauri/quicklook')
const output = join(root, 'src-tauri/target/quicklook')
const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const hostId = process.env.X3FUSE_BUNDLE_ID || config.identifier
const version = config.version.split('-')[0]
const identity = process.env.APPLE_SIGNING_IDENTITY || '-'
const triple = process.env.TAURI_ENV_TARGET_TRIPLE
const archs =
  triple === 'universal-apple-darwin'
    ? ['arm64', 'x86_64']
    : triple
      ? [triple.split('-')[0].replace('aarch64', 'arm64')]
      : [process.arch === 'arm64' ? 'arm64' : 'x86_64']

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' })

for (const [name, kind] of [
  ['X3FThumbnail', 'Thumbnail'],
  ['X3FPreview', 'Preview']
]) {
  const appex = join(output, `${name}.appex`)
  const work = join(output, `${name}.build`)
  rmSync(appex, { recursive: true, force: true })
  mkdirSync(join(appex, 'Contents/MacOS'), { recursive: true })
  mkdirSync(work, { recursive: true })
  const slices = archs.map((arch) => {
    const out = join(work, arch)
    run('swiftc', [
      '-O',
      '-parse-as-library',
      '-application-extension',
      '-module-name',
      name,
      '-target',
      `${arch}-apple-macos14.0`,
      '-o',
      out,
      join(source, 'X3F.swift'),
      join(source, `${kind}.swift`),
      '-Xlinker',
      '-e',
      '-Xlinker',
      '_NSExtensionMain'
    ])
    return out
  })
  run('lipo', ['-create', ...slices, '-output', join(appex, 'Contents/MacOS', name)])
  const plist = join(appex, 'Contents/Info.plist')
  run('cp', [join(source, `${kind}.plist`), plist])
  run('plutil', ['-replace', 'CFBundleIdentifier', '-string', `${hostId}.QuickLook${kind}`, plist])
  run('plutil', ['-replace', 'CFBundleShortVersionString', '-string', version, plist])
  run('plutil', ['-replace', 'CFBundleVersion', '-string', version, plist])
  run('codesign', [
    '--force',
    '--options',
    'runtime',
    ...(identity === '-' ? [] : ['--timestamp']),
    '--entitlements',
    join(source, 'QuickLook.entitlements'),
    '-s',
    identity,
    appex
  ])
}
