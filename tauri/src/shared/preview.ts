import { convertFileSrc } from '@tauri-apps/api/core'
import type { X3FFileDTO } from './types'

export function displayPreviewUrl(file: X3FFileDTO, variant: PreviewVariant = 'preview'): string {
  const url =
    file.displayPreviewUrl ??
    (file.edit ? (file.edit.previewUrl ?? '') : previewUrl(file.path, variant, file.id))
  // Explicit editor frames already exist; reuse them instead of requesting another render.
  if (
    !file.displayPreviewUrl &&
    variant === 'preview' &&
    /^(x3f-edit:\/\/localhost|http:\/\/x3f-edit\.localhost)\//.test(url)
  ) {
    const thumbnail = new URL(url)
    thumbnail.searchParams.set('v', 'thumbnail')
    return thumbnail.toString()
  }
  return url
}
export const isRenderedPreview = (file: X3FFileDTO): boolean =>
  !!file.edit || !!file.displayPreviewUrl

/**
 * Which embedded JPEG to pull out of an X3F file:
 *   - 'preview' — the small embedded preview (~640x480), for thumbnails + histogram
 *   - 'full'    — the full-resolution embedded JPEG, for the large filmstrip preview
 *
 * Sigma X3F files embed several JPEGs; the main process tries them in a quality
 * order per variant and falls back gracefully if a tag is absent.
 */
export type PreviewVariant = 'preview' | 'full'

/**
 * Custom scheme that streams embedded X3F JPEG previews to the renderer
 * (handled in main/previewProtocol.ts).
 */
export const PREVIEW_SCHEME = 'x3f-preview'

/**
 * Build a `x3f-preview://` URL for an absolute file path, usable as an
 * `<img src>` or `fetch()` target in the renderer. A queue file's stable ID
 * keeps browser caches reusable while browsing and fresh after reimporting.
 */
export function previewUrl(
  path: string,
  variant: PreviewVariant = 'preview',
  revision?: string
): string {
  return `${convertFileSrc(path, PREVIEW_SCHEME)}?${revision ? `r=${encodeURIComponent(revision)}&` : ''}v=${variant}`
}
