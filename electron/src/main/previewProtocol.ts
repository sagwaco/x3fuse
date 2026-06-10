import { protocol } from 'electron'
import type { PreviewService, PreviewVariant } from './services/PreviewService'
import { logger } from './services/Logger'

/**
 * Custom scheme that streams embedded X3F JPEG previews to the renderer.
 * Registered as privileged + standard + CORS-enabled (see registerPreviewScheme)
 * so `<img src>` and `fetch()` (for the histogram) both work and the resulting
 * canvas stays untainted.
 *
 * URL shape:  x3f-preview://img/?p=<encodeURIComponent(absPath)>&v=preview|full
 */
export const PREVIEW_SCHEME = 'x3f-preview'

/** Build a `x3f-preview://` URL for an absolute file path. Mirrored in the renderer. */
export function previewUrl(path: string, variant: PreviewVariant = 'preview'): string {
  return `${PREVIEW_SCHEME}://img/?p=${encodeURIComponent(path)}&v=${variant}`
}

/** Must run before `app.ready` (top of main). Marks the scheme secure/standard. */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

/** Must run after `app.ready`. Wires the scheme to the PreviewService. */
export function registerPreviewProtocol(preview: PreviewService): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const path = url.searchParams.get('p')
      const variant = (url.searchParams.get('v') as PreviewVariant) ?? 'preview'
      if (!path) return new Response('missing path', { status: 400 })

      const bytes = await preview.getJpeg(path, variant === 'full' ? 'full' : 'preview')
      if (!bytes) return new Response('no preview', { status: 404 })

      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          // Same-process, content-addressed by mtime in the URL is not used, so
          // keep it modest; the PreviewService LRU is the real cache.
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (e) {
      logger.error(`preview protocol error: ${String(e)}`)
      return new Response('error', { status: 500 })
    }
  })
}
