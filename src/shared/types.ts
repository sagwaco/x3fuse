/** Data models serialized by the Rust backend and used by the renderer. */
import type { EditRecord, SourceCapabilities, SourceKind, X3iSource } from './editor'
import { defaultDenoiseOptions, type DenoiseOptions } from './denoise'
import type { Locale } from './i18n/detect'

export type ConversionStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'warning'

export type OutputFormat = 'dng' | 'embeddedJpg' | 'tiff' | 'jpeg'

export type ColorProfile = 'sRGB' | 'adobeRGB' | 'proPhotoRGB' | 'none'

/** Sigma Color Modes with x3fuse-core's keys and in-camera names. Merrill supports the first six. */
export const COLOR_MODES = [
  ['Standard', 'Standard'],
  ['Vivid', 'Vivid'],
  ['Neutral', 'Neutral'],
  ['Portrait', 'Portrait'],
  ['Landscape', 'Landscape'],
  ['FCBlue', 'FOV Classic Blue'],
  ['SunsetRed', 'Sunset Red'],
  ['ForestGreen', 'Forest Green'],
  ['FCYellow', 'FOV Classic Yellow'],
  ['Cinema', 'Cinema'],
  ['TealAndOrange', 'Teal and Orange']
] as const
export type ColorMode = 'as-shot' | (typeof COLOR_MODES)[number][0]

export type SortField = 'File Name' | 'Date' | 'Size'

export interface ListColumnWidths {
  /** Zero lets the filename column fill the remaining space until resized. */
  name: number
  date: number
  size: number
}

/** How the queue is presented (list, grid, filmstrip, or a survey of the selection). */
export type QueueViewMode = 'list' | 'grid' | 'filmstrip' | 'survey'

/** Pick/reject decision. It is independent of the star rating. */
export type Flag = 'unflagged' | 'pick' | 'reject'

export const SCOPE_MODES = ['histogram', 'rgbParade', 'waveform', 'vectorscope'] as const
export type ScopeMode = (typeof SCOPE_MODES)[number]

/** One labelled metadata row for the inspector's EXIF panel. */
export interface ExifPair {
  label: string
  value: string
}

/** The paths that the queue imports: X3F, X3I, and DNG files. */
export const RAW_PATH = /\.(?:x3[fi]|dng)$/i

/** Output extensions; outputName preserves .X3F for JPEG/TIFF and removes it for DNG. */
export const OUTPUT_EXTENSION: Record<OutputFormat, string> = {
  dng: '.dng',
  embeddedJpg: '.jpg',
  jpeg: '.jpg',
  tiff: '.tif'
}

/** Follow the system appearance, or use the light or dark appearance. */
export type AppearanceMode = 'auto' | 'light' | 'dark'
/** A color theme. Each one can serve the light or the dark appearance. */
export type ThemeName = 'dark' | 'light' | 'gray'

/** 'auto' follows the system language. */
export type LanguageSetting = 'auto' | Locale

export const RESIZE_METHODS = ['nearest', 'bilinear', 'area', 'bicubic', 'lanczos3'] as const
export type ResizeMethod = (typeof RESIZE_METHODS)[number]

/** Fits a rendered export inside a pixel box. The export keeps its aspect ratio and does not get larger. */
export interface ExportResize {
  maxWidth: number
  maxHeight: number
  method: ResizeMethod
}

/** The resize that "Resize to fit" turns on. */
export const DEFAULT_EXPORT_RESIZE: ExportResize = {
  maxWidth: 2048,
  maxHeight: 2048,
  method: 'lanczos3'
}

/** The bounds of a resize dimension, in pixels. */
export const MAX_RESIZE_DIMENSION = 65535

/** Application preferences persisted and validated by the Rust backend. */
export interface ConversionSettings {
  rendering: 'original' | 'rendered'
  jpegQuality: number
  /** Resize for rendered JPEG and TIFF exports; null keeps the full size. Original exports ignore it. */
  resize: ExportResize | null
  editorPanelWidth: number
  /** Whether the editor's adjustments sidebar is open. */
  editorPanelOpen: boolean
  outputFormat: OutputFormat
  compress: boolean
  /** Sensor denoising intensity, 0 = off ... 10 = full strength. */
  denoiseIntensity: number
  denoiseOptions: DenoiseOptions
  colorProfile: ColorProfile
  /** Merrill-generation DNG highlight recovery. */
  dngHighlightRecovery: boolean
  /** Cineon-style flat tone curve for TIFF. */
  cineon: boolean
  /** Sigma Color Mode for TIFF; null exports without one. DNG always embeds every mode. */
  colorMode: ColorMode | null
  /** The frames of an X3I for original exports. Embedded JPG uses the middle exposure. */
  x3iSource: X3iSource
  /** null = write next to each input file; string = custom output directory. */
  outputDirectory: string | null
  debugLoggingEnabled: boolean
  /** True after a batch configuration has been committed. */
  hasPreviousConversion: boolean
  /** Simultaneous conversions: 0 = auto (CPU-derived), 1..MAX_CONCURRENCY = manual. */
  concurrency: number
  sortField: SortField
  sortAscending: boolean
  /** Check for updates at launch and download available updates. */
  autoCheckUpdates: boolean
  autoDownloadUpdates: boolean
  /** Queue presentation: list / thumbnail grid / filmstrip in the desktop app. */
  queueViewMode: QueueViewMode
  /** Whether the right-hand info inspector (histogram + EXIF) is open. */
  inspectorOpen: boolean
  inspectorWidth: number
  exportPanelWidth: number
  listColumnWidths: ListColumnWidths
  inspectorScopeMode: ScopeMode
  /** Last directory confirmed in the X3F import dialog. */
  lastImportDirectory: string | null
  appearanceMode: AppearanceMode
  /** Theme used while the appearance is light. */
  lightTheme: ThemeName
  /** Theme used while the appearance is dark. */
  darkTheme: ThemeName
  /** Keep original and edited previews and photo details on disk. */
  previewCacheEnabled: boolean
  /** Size limit of the preview cache in bytes (decimal units, as shown). */
  previewCacheLimit: number
  language: LanguageSetting
}

export const DEFAULT_SETTINGS: ConversionSettings = {
  rendering: 'original',
  jpegQuality: 92,
  resize: null,
  editorPanelWidth: 320,
  editorPanelOpen: true,
  outputFormat: 'dng',
  compress: false,
  denoiseIntensity: 10,
  denoiseOptions: defaultDenoiseOptions(),
  colorProfile: 'sRGB',
  dngHighlightRecovery: false,
  cineon: false,
  colorMode: null,
  x3iSource: 'merge',
  outputDirectory: null,
  debugLoggingEnabled: false,
  hasPreviousConversion: false,
  concurrency: 0,
  sortField: 'File Name',
  sortAscending: true,
  autoCheckUpdates: true,
  autoDownloadUpdates: false,
  queueViewMode: 'list',
  inspectorOpen: false,
  inspectorWidth: 300,
  exportPanelWidth: 380,
  listColumnWidths: { name: 0, date: 220, size: 110 },
  inspectorScopeMode: 'rgbParade',
  lastImportDirectory: null,
  appearanceMode: 'dark',
  lightTheme: 'light',
  darkTheme: 'dark',
  previewCacheEnabled: true,
  previewCacheLimit: 20_000_000_000,
  language: 'auto'
}

/**
 * Serializable representation of an X3F file in the browsing queue.
 * Conversion results belong to a batch, not to these browsing records.
 */
export interface X3FFileDTO {
  /** Content fingerprint for rendered exports and edits. */
  sourceRevision?: string
  /** Stable revision of the original preview URLs; it changes when the source changes. */
  previewRevision?: string
  edit?: EditRecord
  editError?: string
  /** Immutable render override for editor and export-review snapshots. */
  displayPreviewUrl?: string
  id: string
  /** Absolute path to the source X3F, X3I, or DNG file. */
  path: string
  fileName: string
  sourceKind?: SourceKind
  capabilities?: SourceCapabilities
  /**
   * True for an optimistic placeholder row shown the instant a file is dropped,
   * before main has finished reading its metadata (size, date, orientation,
   * aspect ratio). Small previews show a skeleton until their import batch
   * resolves; full JPEGs can load independently. Renderer-only.
   */
  pending?: boolean
  // EXIF metadata, populated during/after conversion.
  cameraModel?: string
  lensId?: string
  aperture?: string
  /** ISO-8601 string. */
  capturedDate?: string
  /** Source file size in bytes. */
  fileSize?: number
  /** The number of frames in an X3I (Super Fine Detail) photo. */
  frames?: number
  /** Curated inspector rows extracted alongside import metadata. */
  exif?: ExifPair[]
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
  /** Culling state from the backend. Absent on placeholders (unflagged, unrated). */
  flag?: Flag
  /** Star rating: 0 = unrated ... 5. */
  rating?: number
}

// Format-dependent option visibility.

export const shouldShowCompressionOption = (f: OutputFormat): boolean => f === 'dng' || f === 'tiff'

export const shouldShowColorProfileOption = (f: OutputFormat): boolean =>
  f === 'embeddedJpg' || f === 'tiff'

export const shouldShowDngHighlightRecoveryOption = (
  f: OutputFormat,
  cameraModels: readonly (string | undefined)[]
): boolean =>
  f === 'dng' && cameraModels.some((model) => /\b(?:merrill|sd1|dp[123]m)\b/i.test(model ?? ''))

export const cameraModel = (file: Pick<X3FFileDTO, 'cameraModel' | 'exif'>): string | undefined =>
  file.cameraModel ?? file.exif?.find((row) => row.label === 'Camera')?.value

export const shouldShowCineonOption = (f: OutputFormat): boolean => f === 'tiff'

/** x3fuse-core applies a Color Mode to TIFF with a color profile and without Cineon. */
export const shouldShowColorModeOption = (
  s: Pick<ConversionSettings, 'outputFormat' | 'cineon' | 'colorProfile'>
): boolean => s.outputFormat === 'tiff' && !s.cineon && s.colorProfile !== 'none'

/** Options captured once for a conversion batch. */
export type BatchConversionSettings = Pick<
  ConversionSettings,
  | 'outputFormat'
  | 'rendering'
  | 'jpegQuality'
  | 'resize'
  | 'compress'
  | 'denoiseIntensity'
  | 'denoiseOptions'
  | 'colorProfile'
  | 'dngHighlightRecovery'
  | 'cineon'
  | 'colorMode'
  | 'x3iSource'
  | 'outputDirectory'
  | 'concurrency'
>

export function batchSettings(settings: BatchConversionSettings): BatchConversionSettings {
  const {
    rendering,
    jpegQuality,
    resize,
    outputFormat,
    compress,
    denoiseIntensity,
    denoiseOptions,
    colorProfile,
    dngHighlightRecovery,
    cineon,
    colorMode,
    x3iSource,
    outputDirectory,
    concurrency
  } = settings
  return {
    rendering: rendering ?? 'original',
    jpegQuality: jpegQuality ?? 92,
    resize: resize ? { ...resize } : null,
    outputFormat,
    compress,
    denoiseIntensity,
    denoiseOptions: structuredClone(denoiseOptions ?? defaultDenoiseOptions()),
    colorProfile,
    dngHighlightRecovery,
    cineon,
    colorMode: colorMode ?? null,
    x3iSource: x3iSource ?? 'merge',
    outputDirectory,
    concurrency
  }
}

/** The converter preserves .X3F and .X3I in JPEG/TIFF names; DNG drops it. */
export function outputName(fileName: string, format: OutputFormat): string {
  return (
    (format === 'dng' ? fileName.replace(/\.x3[fi]$/i, '') : fileName) + OUTPUT_EXTENSION[format]
  )
}
