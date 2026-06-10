import {
  OUTPUT_EXTENSION,
  resolveSetting,
  type ConversionSettings,
  type X3FFileDTO
} from '@shared/types'
import { basename, stripExt } from './path'

/** The converted file's display name (port of X3FFile.outputFileName). */
export function outputFileName(file: X3FFileDTO, settings: ConversionSettings): string {
  const format = resolveSetting(settings, file.overrides, 'outputFormat')
  return stripExt(basename(file.path)) + OUTPUT_EXTENSION[format]
}
