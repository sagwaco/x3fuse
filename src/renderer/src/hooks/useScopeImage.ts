import { useEffect, useState } from 'react'
import type { PreviewRegion } from '@shared/editor'
import { loadSmallPreview } from '../lib/previewImages'

type ScopeImage = ImageData | 'loading' | null
const cache = new Map<string, ImageData>()

/**
 * Decode once per preview; all scopes share these cropped, oriented pixels.
 * A region (0 to 1 of the cropped, oriented preview) keeps only its pixels.
 */
export function useScopeImage(
  url: string | undefined,
  aspectRatio?: number,
  orientation = 1,
  fileId?: string,
  region?: PreviewRegion | null
): ScopeImage {
  const key = JSON.stringify([url, aspectRatio, orientation, fileId, region])
  const [state, setState] = useState<{
    key: string
    image: ScopeImage
  }>()

  useEffect(() => {
    if (!url) return
    const cached = cache.get(key)
    if (cached) {
      setState({ key, image: cached })
      return
    }
    const controller = new AbortController()
    const save = (image: ScopeImage): void => {
      if (!controller.signal.aborted) setState({ key, image })
    }
    save('loading')
    void (async () => {
      try {
        const source = await loadSmallPreview(
          url,
          orientation,
          aspectRatio,
          controller.signal,
          'selected'
        )
        if (controller.signal.aborted) return
        const context = source.getContext('2d')
        if (!context) throw new Error('no 2d context')
        // ponytail: small previews are capped at 640 px; use full JPEGs if more detail is needed.
        // A region keeps at least one pixel inside the preview.
        const { width, height } = source
        const area = region ?? { x: 0, y: 0, width: 1, height: 1 }
        const w = Math.max(1, Math.min(width, Math.round(area.width * width)))
        const h = Math.max(1, Math.min(height, Math.round(area.height * height)))
        const x = Math.max(0, Math.min(width - w, Math.round(area.x * width)))
        const y = Math.max(0, Math.min(height - h, Math.round(area.y * height)))
        const image = context.getImageData(x, y, w, h)
        cache.set(key, image)
        if (cache.size > 16) cache.delete(cache.keys().next().value!)
        save(image)
      } catch {
        save(null)
      }
    })()
    return () => controller.abort()
    // The key holds the region, so a new object with the same values does not decode again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, aspectRatio, orientation, key])

  if (!url) return null
  // Never display the previous file's pixels while the new effect starts.
  return cache.get(key) ?? (state?.key === key ? state.image : 'loading')
}
