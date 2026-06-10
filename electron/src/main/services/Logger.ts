/**
 * Logger facade used by the conversion services.
 *
 * `logger` delegates to a swappable backend. The default is console-only, which
 * is what unit/integration tests use (they never touch Electron). In the app,
 * main installs the file-writing LogService backend via `setLoggerBackend` at
 * startup — so importing the services never pulls Electron/fs logging into tests.
 */
export interface Logger {
  conversion(message: string, file?: string): void
  error(message: string, file?: string): void
  debug(message: string): void
  command(command: string, args: string[], file?: string): void
  debugEnabled: boolean
}

export function prefix(file?: string): string {
  return file ? `[${file}] ` : ''
}

class ConsoleLogger implements Logger {
  debugEnabled = false

  conversion(message: string, file?: string): void {
    console.log(`CONVERSION: ${prefix(file)}${message}`)
  }

  error(message: string, file?: string): void {
    console.error(`ERROR: ${prefix(file)}${message}`)
  }

  debug(message: string): void {
    if (this.debugEnabled) console.log(`DEBUG: ${message}`)
  }

  command(command: string, args: string[], file?: string): void {
    this.debug(`Executing: ${prefix(file)}${command} ${args.join(' ')}`)
  }
}

let backend: Logger = new ConsoleLogger()

/** Swap the logging backend (main installs LogService here at startup). */
export function setLoggerBackend(next: Logger): void {
  next.debugEnabled = backend.debugEnabled
  backend = next
}

/** Stable facade; always delegates to the current backend. */
export const logger: Logger = {
  conversion: (message, file) => backend.conversion(message, file),
  error: (message, file) => backend.error(message, file),
  debug: (message) => backend.debug(message),
  command: (command, args, file) => backend.command(command, args, file),
  get debugEnabled(): boolean {
    return backend.debugEnabled
  },
  set debugEnabled(value: boolean) {
    backend.debugEnabled = value
  }
}
