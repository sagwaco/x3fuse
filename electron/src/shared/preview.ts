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
 * `<img src>` or `fetch()` target in the renderer.
 */
export function previewUrl(path: string, variant: PreviewVariant = 'preview'): string {
  return `${PREVIEW_SCHEME}://img/?p=${encodeURIComponent(path)}&v=${variant}`
}
