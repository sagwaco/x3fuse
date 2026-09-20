import { useEffect, useState } from 'react'
import { loadSmallPreview } from '../lib/previewImages'

type ScopeImage = ImageData | 'loading' | null
const cache = new Map<string, ImageData>()

/** Decode once per preview; all scopes share these cropped, oriented pixels. */
export function useScopeImage(
  url: string | undefined,
  aspectRatio?: number,
  orientation = 1,
  fileId?: string
): ScopeImage {
  const key = JSON.stringify([url, aspectRatio, orientation, fileId])
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
        const source = await loadSmallPreview(url, orientation, aspectRatio, controller.signal)
        if (controller.signal.aborted) return
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        if (!context) throw new Error('no 2d context')
        // ponytail: cap at the usual embedded preview size; use full JPEGs if more detail is needed.
        const scale = Math.min(1, 640 / Math.max(source.width, source.height))
        canvas.width = Math.max(1, Math.round(source.width * scale))
        canvas.height = Math.max(1, Math.round(source.height * scale))
        context.drawImage(source, 0, 0, canvas.width, canvas.height)
        const image = context.getImageData(0, 0, canvas.width, canvas.height)
        cache.set(key, image)
        if (cache.size > 16) cache.delete(cache.keys().next().value!)
        save(image)
      } catch {
        save(null)
      }
    })()
    return () => controller.abort()
  }, [url, aspectRatio, orientation, key])

  if (!url) return null
  // Never display the previous file's pixels while the new effect starts.
  return cache.get(key) ?? (state?.key === key ? state.image : 'loading')
}
