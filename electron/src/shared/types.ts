/**
 * Shared data models — imported by main, preload, and renderer.
 *
 * These are the TypeScript port of the Swift models:
 *   - Models/ConversionSettings.swift  -> ConversionSettings + DEFAULT_SETTINGS
 *   - Models/X3FFile.swift             -> X3FFileDTO + enums
 *
 * Swift used Int-rawValue enums persisted to UserDefaults; here we use string
 * unions for clarity and keep the integer mapping only at the persistence
 * boundary (see SettingsService migration).
 */

export type ConversionStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'warning'

/** Was Swift `OutputFormat` Int rawValue 0/1/2. */
export type OutputFormat = 'dng' | 'embeddedJpg' | 'tiff'

/** Was Swift `ColorProfile` Int rawValue 0..3. */
export type ColorProfile = 'sRGB' | 'adobeRGB' | 'proPhotoRGB' | 'none'

export type SortField = 'File Name' | 'Status' | 'Date' | 'Size'

/** How the queue is presented (Electron-only QoL addition, not in the Swift app). */
export type QueueViewMode = 'list' | 'grid' | 'filmstrip'

/** One labelled metadata row for the inspector's EXIF panel. */
export interface ExifPair {
  label: string
  value: string
}

/**
 * Output file extension per format (mirrors `OutputFormat.fileExtension`).
 * Includes the leading dot. Note x3f_extract appends this to the *full* input
 * name, e.g. `image.X3F` -> `image.X3F.dng`; the DNG case is then renamed to
 * `image.dng` by the pipeline (see ConversionService).
 */
export const OUTPUT_EXTENSION: Record<OutputFormat, string> = {
  dng: '.dng',
  embeddedJpg: '.jpg',
  tiff: '.tif'
}

/**
 * Maps a color profile to the `-color <value>` argument for x3f_extract.
 * `sRGB` is the default and emits no flag (null), mirroring
 * `ColorProfile.x3fArgument` in X3FFile.swift.
 */
export const COLOR_PROFILE_ARG: Record<ColorProfile, string | null> = {
  sRGB: null,
  adobeRGB: 'AdobeRGB',
  proPhotoRGB: 'ProPhotoRGB',
  none: 'None'
}

/** Global conversion settings (port of ConversionSettings.shared). */
export interface ConversionSettings {
  outputFormat: OutputFormat
  compress: boolean
  /** OpenCV NLM denoise intensity, 0 = off ... 10 = full strength. */
  denoiseIntensity: number
  colorProfile: ColorProfile
  /** Merrill-generation DNG highlight recovery (-dng-highlight-recovery). */
  dngHighlightRecovery: boolean
  /** Cineon-style flat tone curve for TIFF (-cineon). */
  cineon: boolean
  /** null = write next to each input file; string = custom output directory. */
  outputDirectory: string | null
  debugLoggingEnabled: boolean
  /** Only process files still in the `queued` state, not already-converted ones. */
  onlyProcessNewItems: boolean
  /** Simultaneous conversions: 0 = auto (CPU-derived), 1..MAX_CONCURRENCY = manual. */
  concurrency: number
  sortField: SortField
  sortAscending: boolean
  /** Sparkle -> electron-updater. Persisted here for parity with the macOS app. */
  autoCheckUpdates: boolean
  autoDownloadUpdates: boolean
  /** Queue presentation: list / thumbnail grid / filmstrip (Electron-only). */
  queueViewMode: QueueViewMode
  /** Whether the right-hand info inspector (histogram + EXIF) is open. */
  inspectorOpen: boolean
}

export const DEFAULT_SETTINGS: ConversionSettings = {
  outputFormat: 'dng',
  compress: false,
  denoiseIntensity: 10,
  colorProfile: 'sRGB',
  dngHighlightRecovery: false,
  cineon: false,
  outputDirectory: null,
  debugLoggingEnabled: false,
  onlyProcessNewItems: true,
  concurrency: 0,
  sortField: 'File Name',
  sortAscending: true,
  autoCheckUpdates: true,
  autoDownloadUpdates: false,
  queueViewMode: 'list',
  inspectorOpen: false
}

/** Per-file overrides; when a field is undefined the global setting is used. */
export interface FileOverrides {
  outputFormat?: OutputFormat
  compress?: boolean
  denoiseIntensity?: number
  colorProfile?: ColorProfile
}

/**
 * Serializable representation of an X3F file in the queue (port of X3FFile).
 * Crosses the IPC boundary, so it carries no AppKit/SwiftUI-only fields —
 * status color/icon are a presentation concern resolved in the renderer.
 */
export interface X3FFileDTO {
  id: string
  /** Absolute path to the source .X3F file. */
  path: string
  fileName: string
  status: ConversionStatus
  /** 0.0 – 1.0 */
  progress: number
  /**
   * True for an optimistic placeholder row shown the instant a file is dropped,
   * before main has finished reading its metadata (size, date, orientation,
   * aspect ratio). The UI renders a spinner/skeleton for these; the flag is
   * cleared once `queue:add` resolves. Renderer-only — never crosses from main.
   */
  pending?: boolean
  errorMessage?: string
  warningMessage?: string
  /** Absolute path of the produced output file, set when status becomes `completed`. */
  outputPath?: string

  // EXIF metadata, populated during/after conversion.
  cameraModel?: string
  lensId?: string
  aperture?: string
  /** ISO-8601 string. */
  capturedDate?: string
  /** Source file size in bytes. */
  fileSize?: number
  exif?: Record<string, unknown>
  /**
   * EXIF Orientation (1–8). The Foveon sensor is landscape-native. The small
   * PreviewImage (used for thumbnails) carries no orientation of its own, so the
   * UI applies this rotation when displaying it. The full-res JpgFromRaw (large
   * preview) embeds its own EXIF Orientation and is shown as a self-orienting
   * `<img>`. Absent/1 = no rotation.
   */
  orientation?: number
  /**
   * Intended image aspect ratio (stored width / height, pre-orientation). Sigma
   * cameras fit non-4:3 crops inside the fixed 640×480 preview frame with black
   * letterbox bars; the UI crops previews to this ratio to hide them. Absent =
   * use the preview as-is.
   */
  aspectRatio?: number

  overrides?: FileOverrides
}

/** Resolve an effective setting value: per-file override wins over global. */
export function resolveSetting<K extends keyof FileOverrides>(
  settings: ConversionSettings,
  overrides: FileOverrides | undefined,
  key: K
): ConversionSettings[K & keyof ConversionSettings] {
  const override = overrides?.[key]
  if (override !== undefined) {
    return override as ConversionSettings[K & keyof ConversionSettings]
  }
  return settings[key as keyof ConversionSettings] as ConversionSettings[K & keyof ConversionSettings]
}

/** mirrors ConversionSettings.effectiveOutputDirectory(for:) */
export function effectiveOutputDirectory(settings: ConversionSettings, inputDir: string): string {
  return settings.outputDirectory ?? inputDir
}

// --- Format-dependent option visibility (ConversionSettings.swift:122-139) ---

export const shouldShowCompressionOption = (f: OutputFormat): boolean =>
  f === 'dng' || f === 'tiff'

export const shouldShowColorProfileOption = (f: OutputFormat): boolean =>
  f === 'embeddedJpg' || f === 'tiff'

export const shouldShowDngHighlightRecoveryOption = (f: OutputFormat): boolean => f === 'dng'

export const shouldShowCineonOption = (f: OutputFormat): boolean => f === 'tiff'
