/**
 * Pure builder for the x3f_extract command line.
 *
 * This is a faithful, line-for-line port of `X3FConverter.buildX3FArguments`
 * (X3Fuse/Services/X3FConverter.swift:126) plus the trailing input-path append
 * from `runX3FConversion` (X3FConverter.swift:28). It is intentionally pure and
 * dependency-free so it can be unit-tested for byte-for-byte parity with Swift
 * and reused if the conversion backend ever moves to a native (FFI) path.
 *
 * NOTE: the unused `ConversionSettings.buildX3FArguments()` in the Swift app
 * (which emits `-sgain` and omits `-o`) is DEAD CODE and is deliberately NOT
 * ported here. The pipeline only ever ran the X3FConverter variant.
 *
 * Flag order (matters — keep identical to Swift):
 *   -o <outputDir>
 *   -v
 *   [-denoise <0-10>]            when intensity != 10
 *   [-compress]                  when compress && (dng || tiff)
 *   [-jpg | -tiff]               dng emits no flag
 *   [-dng-highlight-recovery]    when dng && dngHighlightRecovery
 *   [-opcodes-dir <dir>]         when dng && !dngHighlightRecovery && opcodesDir
 *   [-cineon]                    when tiff && cineon
 *   [-color <profile>]           when colorProfile != sRGB
 *   <inputPath>                  always last
 */

import {
  COLOR_PROFILE_ARG,
  resolveSetting,
  type ConversionSettings,
  type FileOverrides
} from './types'

export interface BuildArgsInput {
  settings: ConversionSettings
  /** Absolute path to the source .X3F file (appended last). */
  inputPath: string
  /** Effective output directory (already resolved via effectiveOutputDirectory). */
  outputDir: string
  /** Per-file overrides, if any. */
  overrides?: FileOverrides
  /**
   * Absolute path to the bundled opcodes directory, or null when unavailable.
   * Only used for DNG output without highlight recovery.
   */
  opcodesDir: string | null
}

export function buildX3FArgs(input: BuildArgsInput): string[] {
  const { settings, inputPath, outputDir, overrides, opcodesDir } = input

  // Per-file override wins over global; the last three globals have no overrides.
  const outputFormat = resolveSetting(settings, overrides, 'outputFormat')
  const compress = resolveSetting(settings, overrides, 'compress')
  const denoiseIntensity = resolveSetting(settings, overrides, 'denoiseIntensity')
  const colorProfile = resolveSetting(settings, overrides, 'colorProfile')
  const dngHighlightRecovery = settings.dngHighlightRecovery
  const cineon = settings.cineon

  const args: string[] = []

  args.push('-o', outputDir)
  args.push('-v')

  // Denoise intensity (default 10/full strength, so only pass when it differs).
  if (denoiseIntensity !== 10) {
    args.push('-denoise', String(denoiseIntensity))
  }

  // Compression (only for DNG and TIFF).
  if (compress && (outputFormat === 'dng' || outputFormat === 'tiff')) {
    args.push('-compress')
  }

  // Output format (DNG is the default and emits no flag).
  if (outputFormat === 'embeddedJpg') {
    args.push('-jpg')
  } else if (outputFormat === 'tiff') {
    args.push('-tiff')
  }

  // Merrill-generation DNG highlight recovery (DNG only).
  if (dngHighlightRecovery && outputFormat === 'dng') {
    args.push('-dng-highlight-recovery')
  }

  // DNG lens-correction opcodes (DNG only). Highlight recovery is incompatible
  // with flat-fielding, so opcodes are skipped when it is enabled.
  if (outputFormat === 'dng' && !dngHighlightRecovery && opcodesDir) {
    args.push('-opcodes-dir', opcodesDir)
  }

  // Cineon-style flat tone curve (TIFF only).
  if (cineon && outputFormat === 'tiff') {
    args.push('-cineon')
  }

  // Color profile (sRGB is the default and emits no flag).
  const colorArg = COLOR_PROFILE_ARG[colorProfile]
  if (colorArg) {
    args.push('-color', colorArg)
  }

  // Input file is always the final positional argument.
  args.push(inputPath)

  return args
}
