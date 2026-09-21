import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, mkdtemp, copyFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let input = process.env.X3FUSE_SMOKE_FILE
if (!input || !isAbsolute(input)) throw new Error('Set X3FUSE_SMOKE_FILE to an absolute X3F path')
await access(input)
if (process.argv.includes('--build')) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const args of [
    ['run', 'sync:resources'],
    ['run', 'tauri', '--', 'build', '--debug', '--no-bundle']
  ]) {
    const build = spawn(npm, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, VITE_NATIVE_SMOKE: '1' }
    })
    await new Promise((resolveBuild, reject) => {
      build.once('error', reject)
      build.once('exit', (code, signal) =>
        code === 0
          ? resolveBuild()
          : reject(new Error(`Native smoke build failed: ${signal || code}`))
      )
    })
  }
}
const report = resolve(
  process.env.X3FUSE_SMOKE_REPORT ||
    join(root, 'artifacts', `native-smoke-${process.platform}.json`)
)
const executable = join(
  root,
  'src-tauri',
  'target',
  'debug',
  process.platform === 'win32' ? 'x3fuse-tauri.exe' : 'x3fuse-tauri'
)
await access(executable).catch(() => {
  throw new Error('First run: npm run test:native -- --build')
})
await mkdir(dirname(report), { recursive: true })
await rm(report, { force: true })
const editorTemporary =
  process.env.X3FUSE_EDITOR_SMOKE === '1'
    ? await mkdtemp(join(tmpdir(), 'x3fuse-editor-smoke-'))
    : null
if (editorTemporary) {
  const copied = join(editorTemporary, basename(input))
  await copyFile(input, copied)
  input = copied
}
const child = spawn(executable, [], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, X3FUSE_SMOKE_FILE: input, X3FUSE_SMOKE_REPORT: report }
})
const timeout = setTimeout(() => child.kill('SIGKILL'), 100000)
try {
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      signal ? reject(new Error(`Native smoke terminated by ${signal}`)) : resolveExit(code)
    )
  })
  const result = JSON.parse(await readFile(report, 'utf8'))
  console.log(`Native smoke report: ${report}`)
  console.log(JSON.stringify(result, null, 2))
  if (code !== 0 || !result.ok) throw new Error(result.error || `Native smoke exited ${code}`)
} finally {
  clearTimeout(timeout)
  if (editorTemporary) await rm(editorTemporary, { recursive: true, force: true })
}
