/** Which embedded JPEG to request from the x3f-preview:// scheme. */
export type PreviewVariant = 'preview' | 'full'

/**
 * Build a URL the renderer can use as an `<img src>` (or `fetch`) for an X3F's
 * embedded preview. Served by the main-process custom protocol
 * (see main/previewProtocol.ts). Kept in sync with `previewUrl` there.
 */
export function previewUrl(path: string, variant: PreviewVariant = 'preview'): string {
  return `x3f-preview://img/?p=${encodeURIComponent(path)}&v=${variant}`
}
