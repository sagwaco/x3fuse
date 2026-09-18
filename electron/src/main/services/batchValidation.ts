import { access, stat } from 'fs/promises'
import { constants, existsSync } from 'fs'
import { basename, dirname, isAbsolute, join } from 'path'
import type { ConvertFile, OutputConflict } from '@shared/ipc'
import { batchSettings, OUTPUT_EXTENSION, type BatchConversionSettings } from '@shared/types'
import { normalizeSettings } from '@shared/settingsMigration'
import { outputFilePath } from './queueHelpers'

/** Validate the IPC boundary before checking or starting a batch. */
export async function validateBatch(
  files: ConvertFile[],
  settings: BatchConversionSettings
): Promise<OutputConflict[]> {
  if (!settings || typeof settings !== 'object' || !Array.isArray(files) || files.length === 0)
    throw new Error('Invalid conversion batch')
  const normalized = batchSettings(normalizeSettings(settings))
  for (const key of Object.keys(normalized) as (keyof BatchConversionSettings)[]) {
    if (settings[key] !== normalized[key]) throw new Error(`Invalid conversion setting: ${key}`)
  }
  if (settings.outputDirectory !== null && !isAbsolute(settings.outputDirectory)) {
    throw new Error('Output directory must be an absolute path')
  }
  const ids = new Set<string>()
  const directories = new Set<string>()
  for (const file of files) {
    if (
      !file ||
      typeof file.id !== 'string' ||
      !file.id ||
      ids.has(file.id) ||
      typeof file.path !== 'string' ||
      !isAbsolute(file.path) ||
      !file.path.toLowerCase().endsWith('.x3f')
    )
      throw new Error('Invalid conversion file')
    ids.add(file.id)
    directories.add(settings.outputDirectory ?? dirname(file.path))
  }
  for (const directory of directories) {
    if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`)
    await access(directory, constants.W_OK)
  }
  const targets = new Map<string, OutputConflict[]>()
  const conflicts = new Map<string, OutputConflict>()
  for (const file of files) {
    const outputPath = outputFilePath(settings, file.path)
    const intermediate = join(
      dirname(outputPath),
      basename(file.path) + OUTPUT_EXTENSION[settings.outputFormat]
    )
    const conflict = { id: file.id, outputPath }
    if (existsSync(outputPath) || existsSync(intermediate)) conflicts.set(file.id, conflict)
    // Conservative identity matches the converter's serialization on all platforms.
    const key = outputPath.toLowerCase()
    const group = targets.get(key) ?? []
    group.push(conflict)
    targets.set(key, group)
  }
  for (const group of targets.values()) {
    if (group.length > 1) for (const conflict of group) conflicts.set(conflict.id, conflict)
  }
  return [...conflicts.values()]
}
