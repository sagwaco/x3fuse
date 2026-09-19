import { useEffect, useState } from 'react'
import { drawImageWithOrientation } from '../lib/orientation'

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
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`preview ${res.status}`)
        const bitmap = await createImageBitmap(await res.blob(), { imageOrientation: 'none' })
        try {
          if (controller.signal.aborted) return
          const canvas = document.createElement('canvas')
          if (!canvas.getContext('2d')) throw new Error('no 2d context')
          // ponytail: preview samples cap at 320px; use larger samples if fine detail matters.
          drawImageWithOrientation(canvas, bitmap, orientation, { maxEdge: 320, aspectRatio })
          const image = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height)
          cache.set(key, image)
          if (cache.size > 16) cache.delete(cache.keys().next().value!)
          save(image)
        } finally {
          bitmap.close()
        }
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
