import { chmod, mkdir, rename, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import {
  OUTPUT_EXTENSION,
  effectiveOutputDirectory,
  resolveSetting,
  type ConversionSettings,
  type ConversionStatus,
  type FileOverrides
} from '@shared/types'
import { buildX3FArgs } from '@shared/argv'
import type { BinaryResolver } from './BinaryResolver'
import type { ExifService } from './ExifService'
import { spawnCapture } from './ProcessRunner'
import { resolveConcurrency, runWithConcurrency } from './concurrency'
import { ConversionError, isCancellation } from './errors'
import { noopSink, type EventSink } from './events'
import { logger } from './Logger'

export interface ConversionInputFile {
  id: string
  /** Absolute path to the source .X3F file. */
  path: string
  overrides?: FileOverrides
}

export interface BatchResult {
  completed: number
  failed: number
  warnings: number
  total: number
}

const SIGTERM_EXIT_CODE = 15

/**
 * Backend abstraction so the convert path can later swap from CLI-subprocess to
 * a native (napi-rs/FFI) implementation without touching callers.
 */
export interface ConversionBackend {
  convert(files: ConversionInputFile[], settings: ConversionSettings): Promise<BatchResult>
  stop(): void
  readonly isRunning: boolean
}

/**
 * CLI-subprocess port of FileProcessor + X3FConverter + FileValidator.
 * Processes files through a bounded worker pool (see defaultConcurrency);
 * emits file:status / file:progress events at the same checkpoints as the
 * Swift pipeline (0.1, 0.3, 0.7, 0.9, 1.0).
 */
export class ConversionService implements ConversionBackend {
  private cancelling = false
  private running = false
  private readonly activeChildren = new Set<ChildProcess>()

  constructor(
    private readonly resolver: BinaryResolver,
    private readonly exif: ExifService,
    private readonly sink: EventSink = noopSink
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  /** Request cancellation: SIGTERM every live child, with a Windows taskkill fallback. */
  stop(): void {
    logger.conversion('Stop conversion requested')
    this.cancelling = true
    for (const child of this.activeChildren) {
      if (child.killed) continue
      child.kill('SIGTERM')
      if (process.platform === 'win32' && child.pid) {
        const pid = child.pid
        setTimeout(() => {
          if (this.activeChildren.has(child)) {
            spawn('taskkill', ['/pid', String(pid), '/t', '/f'])
          }
        }, 3000)
      }
    }
  }

  async convert(
    files: ConversionInputFile[],
    settings: ConversionSettings
  ): Promise<BatchResult> {
    // The renderer's isProcessing flag is client state (lost on reload), so
    // re-entry must be refused here too: two batches would share cancelling/
    // activeChildren and could write the same outputs.
    if (this.running) {
      throw new ConversionError('conversionFailed', 'A conversion is already running')
    }
    this.cancelling = false
    this.running = true
    const result: BatchResult = { completed: 0, failed: 0, warnings: 0, total: files.length }
    const groups = this.groupByOutputTarget(files, settings)
    const limit = resolveConcurrency(settings.concurrency)
    logger.conversion(`Converting ${files.length} file(s), concurrency ${limit}`)

    try {
      await runWithConcurrency(groups, limit, async (group) => {
        for (const file of group) {
          if (this.cancelling) {
            logger.conversion('Conversion cancelled by user')
            return
          }
          try {
            const outcome = await this.processFile(file, settings)
            if (outcome === 'warning') result.warnings += 1
            result.completed += 1
          } catch (e) {
            if (isCancellation(e)) {
              logger.conversion(`File conversion cancelled: ${basename(file.path)}`)
              this.setStatus(file.id, 'queued')
            } else {
              const message = e instanceof Error ? e.message : String(e)
              logger.error(message, basename(file.path))
              result.failed += 1
              this.setStatus(file.id, 'failed', message)
            }
          }
        }
      })
    } finally {
      this.running = false
      this.activeChildren.clear()
      // Emitted even when the pool throws: this event is what releases the
      // renderer's isProcessing state.
      this.sink.emit('batch:complete', result)
    }

    return result
  }

  /**
   * Group files by final output identity (output dir + basename without
   * extension + output format extension, lowercased for case-insensitive
   * filesystems). Files sharing a target would race on the same intermediate
   * "<name>.X3F.<ext>" and the rm/rename in renameDngOutput, so each group
   * runs serially inside one pool lane (last-writer-wins, as the serial
   * pipeline behaved); distinct targets parallelize freely.
   */
  private groupByOutputTarget(
    files: ConversionInputFile[],
    settings: ConversionSettings
  ): ConversionInputFile[][] {
    const groups = new Map<string, ConversionInputFile[]>()
    for (const file of files) {
      const outputFormat = resolveSetting(settings, file.overrides, 'outputFormat')
      const outputDir = effectiveOutputDirectory(settings, dirname(file.path))
      const base = basename(file.path, extname(file.path))
      const key = `${outputDir}|${base}|${OUTPUT_EXTENSION[outputFormat]}`.toLowerCase()
      const group = groups.get(key)
      if (group) group.push(file)
      else groups.set(key, [file])
    }
    return [...groups.values()]
  }

  private async processFile(
    file: ConversionInputFile,
    settings: ConversionSettings
  ): Promise<'completed' | 'warning'> {
    const name = basename(file.path)
    logger.conversion('Starting conversion', name)
    this.setStatus(file.id, 'processing')

    const outputFormat = resolveSetting(settings, file.overrides, 'outputFormat')
    const outputDir = effectiveOutputDirectory(settings, dirname(file.path))
    // x3f_extract appends the format extension to the FULL input name,
    // e.g. "DP2M0981.X3F" -> "DP2M0981.X3F.dng".
    const ext = OUTPUT_EXTENSION[outputFormat].slice(1)
    const intermediateOutput = join(outputDir, `${name}.${ext}`)

    // Once x3f_extract has run, cancellation leaves a partial/unrenamed
    // intermediate behind, which the catch below removes (port of
    // ConversionQueue.cleanupTemporaryFilesForFile). Before that point an
    // existing intermediate is a previous conversion's output, not ours to delete.
    let extractRan = false
    try {
      this.checkCancel()

      // Step 0: ensure output directory exists.
      await mkdir(outputDir, { recursive: true })

      // Step 1 (0.10): extract EXIF. Informational only (opcode selection happens
      // inside x3f_extract), so a failure here is non-fatal — mirrors the Swift
      // fallback that logs and continues.
      this.setProgress(file.id, 0.1)
      this.checkCancel()
      try {
        const exif = await this.exif.extract(file.path)
        logger.debug(
          `EXIF ${name}: model=${exif.cameraModel ?? '?'} aperture=${exif.aperture ?? '?'} lens=${exif.lensId ?? '?'}`
        )
      } catch (e) {
        logger.error(`EXIF extraction failed (continuing): ${String(e)}`, name)
      }

      // Step 2 (0.30): run x3f_extract.
      this.setProgress(file.id, 0.3)
      this.checkCancel()
      extractRan = true
      await this.runX3FExtract(file, settings, outputDir)

      // Step 3 (0.70): copy EXIF onto the DNG (DNG only).
      this.setProgress(file.id, 0.7)
      this.checkCancel()
      if (outputFormat === 'dng') {
        if (!existsSync(intermediateOutput)) {
          throw new ConversionError('missingOutputFile', `Output file not found: ${intermediateOutput}`)
        }
        await this.exif.copyAllTags(file.path, intermediateOutput)
      }

      // Step 4 (0.90): validate output (exists & size > 0).
      this.setProgress(file.id, 0.9)
      this.checkCancel()
      await this.validateOutput(intermediateOutput)

      // Last cancellation point: past here the validated output is kept and the
      // file completes even if a cancel arrives mid-rename.
      this.checkCancel()

      // Step 5: best-effort 0o644 permissions (unix only; non-fatal).
      if (process.platform !== 'win32') {
        try {
          await chmod(intermediateOutput, 0o644)
        } catch (e) {
          logger.error(`Failed to set output permissions: ${String(e)}`, name)
        }
      }

      // Step 6: rename "<name>.X3F.dng" -> "<base>.dng" (DNG only).
      let finalOutput = intermediateOutput
      if (outputFormat === 'dng') {
        finalOutput = await this.renameDngOutput(file.path, outputDir, ext)
      }

      this.setProgress(file.id, 1.0)
      this.setStatus(file.id, 'completed', undefined, finalOutput)
      logger.conversion(`Conversion completed -> ${basename(finalOutput)}`, name)
      return 'completed'
    } catch (e) {
      if (isCancellation(e) && extractRan) {
        try {
          await rm(intermediateOutput, { force: true })
          logger.conversion(`Removed partial output ${basename(intermediateOutput)}`, name)
        } catch (cleanupError) {
          logger.error(`Failed to remove partial output: ${String(cleanupError)}`, name)
        }
      }
      throw e
    }
  }

  private async runX3FExtract(
    file: ConversionInputFile,
    settings: ConversionSettings,
    outputDir: string
  ): Promise<void> {
    const name = basename(file.path)
    const x3fPath = this.resolver.x3fExtractPath()
    if (!existsSync(x3fPath)) {
      throw new ConversionError('missingBinary', `x3f_extract not found at ${x3fPath}`)
    }

    const args = buildX3FArgs({
      settings,
      inputPath: file.path,
      outputDir,
      overrides: file.overrides,
      opcodesDir: this.resolver.opcodesDir()
    })

    logger.command(x3fPath, args, name)
    const handle = spawnCapture(x3fPath, args, { cwd: outputDir })
    this.activeChildren.add(handle.child)
    // Re-check after registering: a stop() racing the spawn would otherwise
    // miss this child and leave it running.
    if (this.cancelling) {
      handle.child.kill('SIGTERM')
    }
    let code: number | null
    let signal: NodeJS.Signals | null
    let stderr: string
    try {
      ;({ code, signal, stderr } = await handle.result)
    } finally {
      this.activeChildren.delete(handle.child)
    }

    if (this.cancelling || signal === 'SIGTERM' || code === SIGTERM_EXIT_CODE) {
      throw new ConversionError('conversionCancelled', 'Conversion was cancelled by user')
    }
    if (code !== 0) {
      const detail = stderr.trim()
      throw new ConversionError(
        'conversionFailed',
        detail
          ? `x3f_extract failed with exit code ${code}. Error: ${detail}`
          : `x3f_extract failed with exit code ${code}`
      )
    }
    logger.conversion('x3f_extract completed successfully', name)
  }

  private async validateOutput(outputPath: string): Promise<void> {
    let info
    try {
      info = await stat(outputPath)
    } catch {
      throw new ConversionError('missingOutputFile', `Output file was not created: ${outputPath}`)
    }
    if (info.size === 0) {
      throw new ConversionError('invalidOutputFile', 'Output file is empty')
    }
  }

  /** Rename "<fullName>.dng" -> "<baseWithoutX3F>.dng", replacing any existing target. */
  private async renameDngOutput(
    inputPath: string,
    outputDir: string,
    ext: string
  ): Promise<string> {
    const fullName = basename(inputPath) // e.g. DP2M0981.X3F
    const baseName = basename(inputPath, extname(inputPath)) // e.g. DP2M0981
    const current = join(outputDir, `${fullName}.${ext}`)
    const final = join(outputDir, `${baseName}.${ext}`)

    if (current === final) return final
    if (!existsSync(current)) {
      throw new ConversionError('missingOutputFile', `Output file not found for renaming: ${current}`)
    }
    if (existsSync(final)) {
      await rm(final, { force: true })
    }
    await rename(current, final)
    return final
  }

  private checkCancel(): void {
    if (this.cancelling) {
      throw new ConversionError('conversionCancelled', 'Conversion cancelled by user')
    }
  }

  private setStatus(
    id: string,
    status: ConversionStatus,
    message?: string,
    outputPath?: string
  ): void {
    this.sink.emit('file:status', { id, status, message, outputPath })
  }

  private setProgress(id: string, progress: number): void {
    this.sink.emit('file:progress', { id, progress })
  }
}
