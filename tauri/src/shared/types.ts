/** Data models serialized by the Rust backend and used by the renderer. */
import type { EditRecord } from './editor'
import { defaultDenoiseOptions, type DenoiseOptions } from './denoise'

export type ConversionStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'warning'

export type OutputFormat = 'dng' | 'embeddedJpg' | 'tiff' | 'jpeg'

export type ColorProfile = 'sRGB' | 'adobeRGB' | 'proPhotoRGB' | 'none'

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

/** Output extensions; outputName preserves .X3F for JPEG/TIFF and removes it for DNG. */
export const OUTPUT_EXTENSION: Record<OutputFormat, string> = {
  dng: '.dng',
  embeddedJpg: '.jpg',
  jpeg: '.jpg',
  tiff: '.tif'
}

/** Application preferences persisted and validated by the Rust backend. */
export interface ConversionSettings {
  rendering: 'original' | 'rendered'
  jpegQuality: number
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
  /** null = write next to each input file; string = custom output directory. */
  outputDirectory: string | null
  debugLoggingEnabled: boolean
  /** True after a batch configuration has been committed. */
  hasPreviousConversion: boolean
  /** Simultaneous conversions: 0 = auto (CPU-derived), 1..MAX_CONCURRENCY = manual. */
  concurrency: number
  sortField: SortField
  sortAscending: boolean
  /** Reserved update preferences; automatic updates are not implemented yet. */
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
}

export const DEFAULT_SETTINGS: ConversionSettings = {
  rendering: 'original',
  jpegQuality: 92,
  editorPanelWidth: 320,
  editorPanelOpen: true,
  outputFormat: 'dng',
  compress: false,
  denoiseIntensity: 10,
  denoiseOptions: defaultDenoiseOptions(),
  colorProfile: 'sRGB',
  dngHighlightRecovery: false,
  cineon: false,
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
  lastImportDirectory: null
}

/**
 * Serializable representation of an X3F file in the browsing queue.
 * Conversion results belong to a batch, not to these browsing records.
 */
export interface X3FFileDTO {
  sourceRevision?: string
  edit?: EditRecord
  editError?: string
  /** Immutable render override for editor and export-review snapshots. */
  displayPreviewUrl?: string
  id: string
  /** Absolute path to the source .X3F file. */
  path: string
  fileName: string
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

export const shouldShowDngHighlightRecoveryOption = (f: OutputFormat): boolean => f === 'dng'

export const shouldShowCineonOption = (f: OutputFormat): boolean => f === 'tiff'

/** Options captured once for a conversion batch. */
export type BatchConversionSettings = Pick<
  ConversionSettings,
  | 'outputFormat'
  | 'rendering'
  | 'jpegQuality'
  | 'compress'
  | 'denoiseIntensity'
  | 'denoiseOptions'
  | 'colorProfile'
  | 'dngHighlightRecovery'
  | 'cineon'
  | 'outputDirectory'
  | 'concurrency'
>

export function batchSettings(settings: BatchConversionSettings): BatchConversionSettings {
  const {
    rendering,
    jpegQuality,
    outputFormat,
    compress,
    denoiseIntensity,
    denoiseOptions,
    colorProfile,
    dngHighlightRecovery,
    cineon,
    outputDirectory,
    concurrency
  } = settings
  return {
    rendering: rendering ?? 'original',
    jpegQuality: jpegQuality ?? 92,
    outputFormat,
    compress,
    denoiseIntensity,
    denoiseOptions: structuredClone(denoiseOptions ?? defaultDenoiseOptions()),
    colorProfile,
    dngHighlightRecovery,
    cineon,
    outputDirectory,
    concurrency
  }
}

/** The converter preserves .X3F in JPEG/TIFF names; DNG drops it. */
export function outputName(fileName: string, format: OutputFormat): string {
  return (format === 'dng' ? fileName.replace(/\.x3f$/i, '') : fileName) + OUTPUT_EXTENSION[format]
}
