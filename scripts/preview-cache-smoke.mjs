import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = process.env.X3FUSE_CACHE_SMOKE_DIRECTORY
if (!directory || !isAbsolute(directory)) {
  throw new Error('Set X3FUSE_CACHE_SMOKE_DIRECTORY to an absolute RAW folder path')
}
const limit = Number(process.env.X3FUSE_CACHE_SMOKE_LIMIT || 0)
if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid cache benchmark file limit')
const names = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.(x3f|x3i|dng)$/i.test(entry.name))
  .map((entry) => entry.name)
  .sort()
const selected = limit ? names.slice(0, limit) : names
if (!selected.length) throw new Error('Cache benchmark folder has no RAW files')

async function execute(command, args, env, timeout = 1800000) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32' && command.endsWith('.cmd')
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  try {
    await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) =>
        code === 0 ? resolveExit() : reject(new Error(`${command} exited: ${signal || code}`))
      )
    })
  } finally {
    clearTimeout(timer)
  }
}

if (process.argv.includes('--build')) {
  await execute(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'tauri', '--', 'build', '--debug', '--no-bundle'],
    { ...process.env, VITE_NATIVE_SMOKE: '1' }
  )
}
const target = process.env.CARGO_TARGET_DIR || join(root, 'src-tauri', 'target')
const executable = join(target, 'debug', process.platform === 'win32' ? 'x3fuse.exe' : 'x3fuse')
await access(executable)
const temporary = await mkdtemp(join(tmpdir(), 'x3fuse-cache-smoke-'))
const report = resolve(
  process.env.X3FUSE_SMOKE_REPORT ||
    join(root, 'artifacts', `preview-cache-${process.platform}.json`)
)
const result = {
  directory,
  files: selected.length,
  measurement: 'visible-native',
  phases: []
}
try {
  const inputs = join(temporary, 'inputs')
  await mkdir(inputs)
  const paths = []
  for (const name of selected) {
    const copied = join(inputs, name)
    await copyFile(join(directory, name), copied, constants.COPYFILE_FICLONE)
    try {
      await copyFile(join(directory, `${name}.x3fuse.json`), `${copied}.x3fuse.json`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    paths.push(copied)
  }
  const manifest = join(temporary, 'inputs.json')
  await writeFile(manifest, JSON.stringify(paths))
  // Exercise migration from the old default, as an existing installation does.
  const storage = join(temporary, 'storage')
  await mkdir(join(storage, 'config'), { recursive: true })
  await writeFile(
    join(storage, 'config', 'settings.json'),
    JSON.stringify({ previewCacheLimit: 1000000000 })
  )
  for (const warmup of [true, false]) {
    const phaseReport = join(temporary, warmup ? 'cold.json' : 'restart.json')
    let failure
    try {
      await execute(
        executable,
        [],
        {
          ...process.env,
          X3FUSE_SMOKE_FILE: paths[0],
          X3FUSE_SMOKE_REPORT: phaseReport,
          X3FUSE_SMOKE_STORAGE: storage,
          X3FUSE_CACHE_SMOKE_MANIFEST: manifest,
          X3FUSE_CACHE_SMOKE_WARMUP: warmup ? '1' : '0'
        },
        1850000
      )
    } catch (error) {
      failure = error
    }
    const phase = JSON.parse(await readFile(phaseReport, 'utf8'))
    result.phases.push(phase)
    console.log(JSON.stringify(phase, null, 2))
    if (failure || !phase.ok) throw failure || new Error(phase.error || 'Cache benchmark failed')
    if (phase.cacheLimit !== 20000000000) throw new Error('Old cache default was not upgraded')
    if (!warmup && phase.cacheCounters?.misses !== 0) {
      throw new Error('Restart needed uncached previews')
    }
  }
} finally {
  await mkdir(dirname(report), { recursive: true })
  await writeFile(report, JSON.stringify(result, null, 2))
  console.log(`Preview cache report: ${report}`)
  await rm(temporary, { recursive: true, force: true })
}
