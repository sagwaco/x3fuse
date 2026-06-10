import { chmod } from 'fs/promises'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { logger } from './Logger'

export interface ExiftoolInvocation {
  /** Executable to spawn (perl script on unix, packed .exe on Windows). */
  command: string
  /** Args to prepend before the real exiftool args (reserved; empty today). */
  prefixArgs: string[]
}

/**
 * Resolves the bundled binaries (x3f_extract, exiftool) and the opcodes
 * directory across platforms. Ports BinaryManager + OpcodeManager.
 *
 * `resourcesRoot` is injected so the same class serves the packaged app
 * (process.resourcesPath), dev runs (electron/resources), and tests. Layout:
 *
 *   <root>/binaries/<platform>/<arch>/x3f_extract[.exe]
 *   <root>/exiftool/<platform>/exiftool[.exe] (+ lib/ on unix)
 *   <root>/opcodes/<files...>
 */
export class BinaryResolver {
  constructor(
    private readonly resourcesRoot: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly arch: string = process.arch
  ) {}

  private get exeSuffix(): string {
    return this.platform === 'win32' ? '.exe' : ''
  }

  x3fExtractPath(): string {
    return join(
      this.resourcesRoot,
      'binaries',
      this.platform,
      this.arch,
      `x3f_extract${this.exeSuffix}`
    )
  }

  exiftool(): ExiftoolInvocation {
    const dir = join(this.resourcesRoot, 'exiftool', this.platform)
    return { command: join(dir, `exiftool${this.exeSuffix}`), prefixArgs: [] }
  }

  /** Opcodes directory path, or null when it is missing/empty (mirrors OpcodeManager). */
  opcodesDir(): string | null {
    const dir = join(this.resourcesRoot, 'opcodes')
    if (!existsSync(dir)) return null
    try {
      const entries = readdirSync(dir).filter((n) => !n.startsWith('.'))
      return entries.length > 0 ? dir : null
    } catch {
      return null
    }
  }

  /** chmod 0o755 on the executables (unix only; no-op on Windows). */
  async ensurePermissions(): Promise<void> {
    if (this.platform === 'win32') return
    for (const path of [this.x3fExtractPath(), this.exiftool().command]) {
      try {
        await chmod(path, 0o755)
      } catch (e) {
        logger.error(`Failed to chmod ${path}: ${String(e)}`)
      }
    }
  }

  /** Collects setup issues (mirrors BinaryManager.validateBinaries + opcodes check). */
  validate(): string[] {
    const issues: string[] = []
    const x3f = this.x3fExtractPath()
    if (!existsSync(x3f) || !isFile(x3f)) {
      issues.push(`x3f_extract binary not found at ${x3f}`)
    }
    const exiftool = this.exiftool().command
    if (!existsSync(exiftool) || !isFile(exiftool)) {
      issues.push(`exiftool not found at ${exiftool}`)
    }
    if (this.opcodesDir() === null) {
      issues.push('Opcodes directory missing or empty')
    }
    return issues
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
