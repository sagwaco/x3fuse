import { protocol } from 'electron'
import { PREVIEW_SCHEME, type PreviewVariant } from '@shared/preview'
import type { PreviewService } from './services/PreviewService'
import { logger } from './services/Logger'

/**
 * Serves the x3f-preview:// scheme (see shared/preview.ts for the URL shape).
 * Registered as privileged + standard + CORS-enabled (see registerPreviewScheme)
 * so `<img src>` and `fetch()` (for the histogram) both work and the resulting
 * canvas stays untainted.
 */

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
      // Only X3F sources are previewable (same filter as queue:add); refusing
      // everything else keeps this scheme from reading arbitrary files on
      // behalf of a compromised renderer.
      if (!path.toLowerCase().endsWith('.x3f')) {
        return new Response('forbidden', { status: 403 })
      }

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
