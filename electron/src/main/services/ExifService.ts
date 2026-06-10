import type { ExifPair } from '@shared/types'
import type { BinaryResolver } from './BinaryResolver'
import { spawnCapture } from './ProcessRunner'
import { ConversionError } from './errors'
import { logger } from './Logger'

export interface ExtractedExif {
  cameraModel?: string
  lensId?: string
  aperture?: string
  /** Full first-object metadata from exiftool -json. */
  raw: Record<string, unknown>
}

/**
 * Curated, ordered tags shown in the inspector's metadata panel. Labels stay in
 * English (tag-like, matching how most metadata viewers present EXIF); only
 * present values are returned. `format` lets a tag tweak its display value.
 */
const INSPECTOR_TAGS: { tag: string; label: string; format?: (v: string) => string }[] = [
  { tag: 'Model', label: 'Camera' },
  { tag: 'LensID', label: 'Lens' },
  { tag: 'FocalLength', label: 'Focal length' },
  { tag: 'FNumber', label: 'Aperture', format: (v) => `f/${v}` },
  { tag: 'ExposureTime', label: 'Shutter' },
  { tag: 'ISO', label: 'ISO' },
  { tag: 'ExposureCompensation', label: 'Exposure comp.' },
  { tag: 'ExposureProgram', label: 'Program' },
  { tag: 'MeteringMode', label: 'Metering' },
  { tag: 'WhiteBalance', label: 'White balance' },
  { tag: 'ImageSize', label: 'Dimensions', format: (v) => v.replace('x', ' × ') },
  { tag: 'DateTimeOriginal', label: 'Captured' },
  { tag: 'Software', label: 'Software' },
  { tag: 'SerialNumber', label: 'Serial' }
]

/**
 * Port of ExifService. Two operations, both shelling out to the bundled
 * exiftool:
 *   - extract:  exiftool -aperture -model -lensid -json <file>
 *   - copyTags: exiftool -overwrite_original -tagsFromFile <src> -all:all <dst>
 */
export class ExifService {
  constructor(private readonly resolver: BinaryResolver) {}

  /** Extract the EXIF fields used for display / opcode context. Throws on failure. */
  async extract(filePath: string): Promise<ExtractedExif> {
    const out = await this.run(['-aperture', '-model', '-lensid', '-json', filePath])
    return parseExif(out)
  }

  /** Copy all EXIF tags from `sourcePath` onto `destPath`, overwriting in place. */
  async copyAllTags(sourcePath: string, destPath: string): Promise<void> {
    await this.run(['-overwrite_original', '-tagsFromFile', sourcePath, '-all:all', destPath])
  }

  /**
   * Per-file display metadata used by the queue UI — numeric EXIF Orientation
   * (1–8) and the intended aspect ratio (stored width / height) — for many files
   * in a single exiftool call, keyed by the path as passed (exiftool's
   * `SourceFile`). Never throws; returns the partial map on failure.
   */
  async displayMeta(
    paths: string[]
  ): Promise<Map<string, { orientation?: number; aspectRatio?: number }>> {
    const map = new Map<string, { orientation?: number; aspectRatio?: number }>()
    if (paths.length === 0) return map
    try {
      const out = await this.run([
        '-Orientation',
        '-ImageWidth',
        '-ImageHeight',
        '-n',
        '-json',
        ...paths
      ])
      const parsed = JSON.parse(out)
      if (Array.isArray(parsed)) {
        for (const obj of parsed as Record<string, unknown>[]) {
          if (typeof obj.SourceFile !== 'string') continue
          const entry: { orientation?: number; aspectRatio?: number } = {}
          if (typeof obj.Orientation === 'number') entry.orientation = obj.Orientation
          if (
            typeof obj.ImageWidth === 'number' &&
            typeof obj.ImageHeight === 'number' &&
            obj.ImageWidth > 0 &&
            obj.ImageHeight > 0
          ) {
            entry.aspectRatio = obj.ImageWidth / obj.ImageHeight
          }
          map.set(obj.SourceFile, entry)
        }
      }
    } catch (e) {
      logger.debug(`displayMeta failed: ${String(e)}`)
    }
    return map
  }

  /**
   * Curated, display-ready metadata for the inspector panel. Returns only the
   * tags present on the file, in {@link INSPECTOR_TAGS} order. Never throws —
   * returns an empty array on any failure so the UI can show a clean empty state.
   */
  async fullMetadata(filePath: string): Promise<ExifPair[]> {
    try {
      const args = [
        ...INSPECTOR_TAGS.map((t) => `-${t.tag}`),
        '-d',
        '%Y-%m-%d %H:%M:%S',
        '-json',
        filePath
      ]
      const out = await this.run(args)
      const parsed = JSON.parse(out)
      const meta = (Array.isArray(parsed) ? parsed[0] : undefined) as
        | Record<string, unknown>
        | undefined
      if (!meta) return []
      return INSPECTOR_TAGS.flatMap(({ tag, label, format }) => {
        const v = meta[tag]
        if (v == null || v === '') return []
        const value = format ? format(String(v)) : String(v)
        return [{ label, value }]
      })
    } catch (e) {
      logger.debug(`fullMetadata failed for ${filePath}: ${String(e)}`)
      return []
    }
  }

  private async run(args: string[]): Promise<string> {
    const { command, prefixArgs } = this.resolver.exiftool()
    const fullArgs = [...prefixArgs, ...args]
    logger.command(command, fullArgs)

    const { result } = spawnCapture(command, fullArgs)
    const { code, stdout, stderr } = await result
    if (code !== 0) {
      throw new ConversionError(
        'exifProcessingFailed',
        `exiftool exited with code ${code}: ${stderr.trim()}`
      )
    }
    if (stderr.trim()) logger.debug(`exiftool stderr: ${stderr.trim()}`)
    return stdout
  }
}

/** Mirrors ExifService.parseExifData. */
export function parseExif(jsonOutput: string): ExtractedExif {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonOutput)
  } catch {
    throw new ConversionError('exifProcessingFailed', 'Invalid exiftool JSON output')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConversionError('exifProcessingFailed', 'Invalid exiftool JSON output')
  }
  const metadata = parsed[0] as Record<string, unknown>

  const result: ExtractedExif = { raw: metadata }

  if (typeof metadata.Model === 'string') {
    result.cameraModel = metadata.Model
  }

  const aperture = metadata.Aperture
  if (typeof aperture === 'number') {
    result.aperture = aperture.toFixed(1)
  } else if (typeof aperture === 'string') {
    result.aperture = aperture
  }

  const lensId = metadata.LensID
  if (typeof lensId === 'string') {
    result.lensId = lensId
  } else if (typeof lensId === 'number') {
    result.lensId = `Unknown_(${lensId})_30mm`
  }

  return result
}
