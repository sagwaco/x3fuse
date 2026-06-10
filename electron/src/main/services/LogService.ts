import { app, shell } from 'electron'
import { appendFile, mkdir, rm, stat } from 'fs/promises'
import { join } from 'path'
import type { LogSizes } from '@shared/ipc'
import { prefix, setLoggerBackend, type Logger } from './Logger'

/**
 * File-backed 3-log implementation (port of LoggingService.swift): appends
 * timestamped lines to conversion.log / error.log / debug.log in the platform
 * logs directory (app.getPath('logs') — ~/Library/Logs/X3Fuse on macOS, the
 * equivalent on Windows/Linux). Installs itself as the logger backend so all
 * service logging routes here. Direct fs append (no rotation) mirrors the Swift
 * behaviour exactly and keeps the dependency surface small.
 */
export class LogService implements Logger {
  debugEnabled = false

  private readonly dir = app.getPath('logs')
  private readonly conversionFile = join(this.dir, 'conversion.log')
  private readonly errorFile = join(this.dir, 'error.log')
  private readonly debugFile = join(this.dir, 'debug.log')

  // Per-file promise chain so concurrent appends stay ordered.
  private readonly queues = new Map<string, Promise<void>>()

  constructor() {
    void mkdir(this.dir, { recursive: true }).catch(() => {})
    setLoggerBackend(this)
  }

  // --- Logger backend ---

  conversion(message: string, file?: string): void {
    const line = `${prefix(file)}${message}`
    this.write(this.conversionFile, line)
    console.log(`CONVERSION: ${line}`)
  }

  error(message: string, file?: string): void {
    const line = `${prefix(file)}${message}`
    this.write(this.errorFile, line)
    console.error(`ERROR: ${line}`)
  }

  debug(message: string): void {
    if (!this.debugEnabled) return
    this.write(this.debugFile, message)
    console.log(`DEBUG: ${message}`)
  }

  command(command: string, args: string[], file?: string): void {
    // Swift logCommand routes to the conversion log.
    this.conversion(`Executing: ${command} ${args.join(' ')}`, file)
  }

  // --- Log management (ports openLogDirectory / clearLogs / sizes) ---

  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled
  }

  async openDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true }).catch(() => {})
    await shell.openPath(this.dir)
  }

  async clear(): Promise<void> {
    await Promise.all(
      [this.conversionFile, this.errorFile, this.debugFile].map((f) =>
        rm(f, { force: true }).catch(() => {})
      )
    )
    this.debug('Log files cleared')
  }

  async sizes(): Promise<LogSizes> {
    const [conversion, error, debug] = await Promise.all([
      fileSize(this.conversionFile),
      fileSize(this.errorFile),
      fileSize(this.debugFile)
    ])
    return { conversion, error, debug }
  }

  private write(file: string, message: string): void {
    const line = `[${timestamp()}] ${message}\n`
    const prev = this.queues.get(file) ?? Promise.resolve()
    const next = prev
      .then(() => appendFile(file, line))
      .catch((e: unknown) => console.error(`Failed to write log ${file}: ${String(e)}`))
    this.queues.set(file, next)
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** "yyyy-MM-dd HH:mm:ss.SSS" (matches LoggingService.dateFormatter). */
function timestamp(d = new Date()): string {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const p3 = (n: number): string => String(n).padStart(3, '0')
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
  )
}
