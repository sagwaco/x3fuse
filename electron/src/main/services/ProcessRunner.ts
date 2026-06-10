import { spawn, type ChildProcess } from 'child_process'

export interface RunResult {
  /** Exit code, or null when the process was terminated by a signal. */
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface RunHandle {
  child: ChildProcess
  result: Promise<RunResult>
}

/**
 * Spawn a child process and capture stdout/stderr to strings (mirrors the
 * Swift Process + Pipe + readDataToEndOfFile pattern). Returns the live child
 * so the caller can terminate it for cancellation, plus a promise that resolves
 * with the exit code/signal and captured output. Never throws on non-zero exit;
 * a spawn error rejects the promise.
 */
export function spawnCapture(
  command: string,
  args: string[],
  opts: { cwd?: string } = {}
): RunHandle {
  const child = spawn(command, args, { cwd: opts.cwd })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString()
  })
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
  })

  const result = new Promise<RunResult>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })

  return { child, result }
}

export interface RunResultBinary {
  code: number | null
  signal: NodeJS.Signals | null
  /** Raw stdout bytes (never decoded), for binary payloads like embedded JPEGs. */
  stdout: Buffer
  stderr: string
}

/**
 * Like {@link spawnCapture} but keeps stdout as raw bytes. Required for binary
 * output (e.g. `exiftool -b -PreviewImage`) where decoding to a string would
 * corrupt the data. stderr is still captured as text.
 */
export function spawnCaptureBinary(
  command: string,
  args: string[],
  opts: { cwd?: string } = {}
): { child: ChildProcess; result: Promise<RunResultBinary> } {
  const child = spawn(command, args, { cwd: opts.cwd })

  const chunks: Buffer[] = []
  let stderr = ''
  child.stdout?.on('data', (d: Buffer) => {
    chunks.push(d)
  })
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
  })

  const result = new Promise<RunResultBinary>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) =>
      resolve({ code, signal, stdout: Buffer.concat(chunks), stderr })
    )
  })

  return { child, result }
}
