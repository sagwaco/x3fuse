import { randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'
import {
  outputName,
  effectiveOutputDirectory,
  resolveSetting,
  type BatchConversionSettings,
  type FileOverrides,
  type X3FFileDTO
} from '@shared/types'
import { readBasicMetadata } from './FileMetadata'

/**
 * Build the queue DTO for a freshly added file (port of
 * ConversionQueue.addFiles + extractBasicFileMetadata). The id is minted here in
 * main and is the stable key for all subsequent status/progress events.
 */
export async function buildFileDTO(path: string): Promise<X3FFileDTO> {
  const meta = await readBasicMetadata(path)
  return {
    id: randomUUID(),
    path,
    fileName: basename(path),
    fileSize: meta.fileSize,
    capturedDate: meta.capturedDate
  }
}

/**
 * The absolute path of the file x3f_extract ultimately leaves on disk, matching
 * ConversionService's behaviour: DNG is renamed `<full>.dng` -> `<base>.dng`,
 * while JPG/TIFF keep the `<full>.<ext>` name. (This is the *actual* on-disk
 * path; the Swift `X3FFile.outputFilePath` only computed the renamed form and so
 * mis-reported JPG/TIFF existence — corrected here.)
 */
export function outputFilePath(
  settings: BatchConversionSettings,
  path: string,
  overrides?: FileOverrides
): string {
  const format = resolveSetting(settings, overrides, 'outputFormat')
  const dir = effectiveOutputDirectory(settings, dirname(path))
  return join(dir, outputName(basename(path), format))
}
