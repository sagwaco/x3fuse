import { useEffect, useState } from 'react'
import { cropRect } from '../lib/aspectCrop'

/** Per-channel 256-bucket counts for an RGB histogram. */
export interface HistogramData {
  r: number[]
  g: number[]
  b: number[]
}

/** Longest edge the preview is scaled to before binning — plenty for a histogram. */
const SAMPLE_EDGE = 320

/**
 * Compute an RGB histogram from a preview image URL (the x3f-preview:// scheme),
 * excluding the aspect-ratio letterbox bars (`aspectRatio`) so they don't add a
 * spurious black spike. The bytes are fetched into a Blob first so the
 * ImageBitmap is same-origin and the canvas stays untainted (getImageData would
 * otherwise throw). Returns `'loading'` while working and `null` on failure.
 */
export function useHistogram(
  url: string | undefined,
  aspectRatio?: number
): HistogramData | 'loading' | null {
  const [state, setState] = useState<HistogramData | 'loading' | null>(null)

  useEffect(() => {
    if (!url) {
      setState(null)
      return
    }
    let cancelled = false
    setState('loading')
    computeHistogram(url, aspectRatio)
      .then((data) => {
        if (!cancelled) setState(data)
      })
      .catch(() => {
        if (!cancelled) setState(null)
      })
    return () => {
      cancelled = true
    }
  }, [url, aspectRatio])

  return state
}

async function computeHistogram(url: string, aspectRatio?: number): Promise<HistogramData> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`preview ${res.status}`)
  const blob = await res.blob()
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'none' })

  const crop = aspectRatio
    ? cropRect(bitmap.width, bitmap.height, aspectRatio)
    : { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height }
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(crop.sw, crop.sh))
  const w = Math.max(1, Math.round(crop.sw * scale))
  const h = Math.max(1, Math.round(crop.sh * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    bitmap.close()
    throw new Error('no 2d context')
  }
  ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h)
  bitmap.close()

  const { data } = ctx.getImageData(0, 0, w, h)
  const r = new Array(256).fill(0)
  const g = new Array(256).fill(0)
  const b = new Array(256).fill(0)
  for (let i = 0; i < data.length; i += 4) {
    r[data[i]]++
    g[data[i + 1]]++
    b[data[i + 2]]++
  }
  return { r, g, b }
}
