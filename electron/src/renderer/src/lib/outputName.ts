import { outputName, type BatchConversionSettings, type X3FFileDTO } from '@shared/types'
import { basename } from './path'

/** Match main's actual output naming: only DNG drops the source extension. */
export function outputFileName(file: X3FFileDTO, settings: BatchConversionSettings): string {
  return outputName(basename(file.path), settings.outputFormat)
}
