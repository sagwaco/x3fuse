import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const input = process.env.X3FUSE_SMOKE_FILE
if (!input || !isAbsolute(input)) throw new Error('Set X3FUSE_SMOKE_FILE to an absolute X3F path')
await access(input)
const report = resolve(process.env.X3FUSE_SMOKE_REPORT || join(root, 'artifacts', `native-smoke-${process.platform}.json`))
const executable = join(root, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'x3fuse-tauri.exe' : 'x3fuse-tauri')
await access(executable).catch(() => { throw new Error('First run: npm run tauri -- build --debug --no-bundle') })
await mkdir(dirname(report), { recursive: true })
await rm(report, { force: true })
const child = spawn(executable, [], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, X3FUSE_SMOKE_FILE: input, X3FUSE_SMOKE_REPORT: report }
})
const timeout = setTimeout(() => child.kill('SIGKILL'), 55000)
try {
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => signal ? reject(new Error(`Native smoke terminated by ${signal}`)) : resolveExit(code))
  })
  const result = JSON.parse(await readFile(report, 'utf8'))
  console.log(`Native smoke report: ${report}`)
  console.log(JSON.stringify(result, null, 2))
  if (code !== 0 || !result.ok) throw new Error(result.error || `Native smoke exited ${code}`)
} finally {
  clearTimeout(timeout)
}
