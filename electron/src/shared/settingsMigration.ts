/**
 * Pure settings normalization/migration — no Electron/Node deps so it can be
 * unit-tested directly. Ports the legacy handling in
 * ConversionSettings.loadSettings (ConversionSettings.swift:81):
 *   - int-rawValue enums (UserDefaults) -> string unions
 *   - legacy `denoise: Bool` -> denoiseIntensity (true=10, false=0)
 *   - clamp denoiseIntensity to 0...10
 * Any unknown/invalid field falls back to DEFAULT_SETTINGS.
 */
import {
  DEFAULT_SETTINGS,
  type ColorProfile,
  type ConversionSettings,
  type OutputFormat,
  type QueueViewMode,
  type SortField
} from './types'
import { MAX_CONCURRENCY } from './concurrency'

// Legacy Int rawValue order (Swift OutputFormat/ColorProfile).
const OUTPUT_FORMATS: OutputFormat[] = ['dng', 'embeddedJpg', 'tiff']
const COLOR_PROFILES: ColorProfile[] = ['sRGB', 'adobeRGB', 'proPhotoRGB', 'none']
// 'Status' (a Swift-app sort option with no UI here) coerces to the default.
const SORT_FIELDS: SortField[] = ['File Name', 'Date', 'Size']
const VIEW_MODES: QueueViewMode[] = ['list', 'grid', 'filmstrip']

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function coerceOutputFormat(v: unknown): OutputFormat {
  if (typeof v === 'string' && (OUTPUT_FORMATS as string[]).includes(v)) return v as OutputFormat
  if (typeof v === 'number' && OUTPUT_FORMATS[v]) return OUTPUT_FORMATS[v]
  return DEFAULT_SETTINGS.outputFormat
}

function coerceColorProfile(v: unknown): ColorProfile {
  if (typeof v === 'string' && (COLOR_PROFILES as string[]).includes(v)) return v as ColorProfile
  if (typeof v === 'number' && COLOR_PROFILES[v]) return COLOR_PROFILES[v]
  return DEFAULT_SETTINGS.colorProfile
}

function coerceDenoise(raw: Record<string, unknown>): number {
  let n: number
  if (typeof raw.denoiseIntensity === 'number') n = raw.denoiseIntensity
  else if (typeof raw.denoise === 'boolean') n = raw.denoise ? 10 : 0
  else n = DEFAULT_SETTINGS.denoiseIntensity
  return Math.min(10, Math.max(0, Math.round(n)))
}

function coerceSortField(v: unknown): SortField {
  return typeof v === 'string' && (SORT_FIELDS as string[]).includes(v)
    ? (v as SortField)
    : DEFAULT_SETTINGS.sortField
}

function coerceOutputDir(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** 0 = auto; 1..MAX_CONCURRENCY = manual. */
function coerceConcurrency(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.concurrency
  return Math.min(MAX_CONCURRENCY, Math.max(0, Math.round(v)))
}

function coerceViewMode(v: unknown): QueueViewMode {
  return typeof v === 'string' && (VIEW_MODES as string[]).includes(v)
    ? (v as QueueViewMode)
    : DEFAULT_SETTINGS.queueViewMode
}

export function normalizeSettings(raw: unknown): ConversionSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    outputFormat: coerceOutputFormat(r.outputFormat),
    compress: asBool(r.compress, DEFAULT_SETTINGS.compress),
    denoiseIntensity: coerceDenoise(r),
    colorProfile: coerceColorProfile(r.colorProfile),
    dngHighlightRecovery: asBool(r.dngHighlightRecovery, DEFAULT_SETTINGS.dngHighlightRecovery),
    cineon: asBool(r.cineon, DEFAULT_SETTINGS.cineon),
    outputDirectory: coerceOutputDir(r.outputDirectory),
    debugLoggingEnabled: asBool(r.debugLoggingEnabled, DEFAULT_SETTINGS.debugLoggingEnabled),
    onlyProcessNewItems: asBool(r.onlyProcessNewItems, DEFAULT_SETTINGS.onlyProcessNewItems),
    concurrency: coerceConcurrency(r.concurrency),
    sortField: coerceSortField(r.sortField),
    sortAscending: asBool(r.sortAscending, DEFAULT_SETTINGS.sortAscending),
    autoCheckUpdates: asBool(r.autoCheckUpdates, DEFAULT_SETTINGS.autoCheckUpdates),
    autoDownloadUpdates: asBool(r.autoDownloadUpdates, DEFAULT_SETTINGS.autoDownloadUpdates),
    queueViewMode: coerceViewMode(r.queueViewMode),
    inspectorOpen: asBool(r.inspectorOpen, DEFAULT_SETTINGS.inspectorOpen)
  }
}
