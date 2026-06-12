import { useEffect, useRef, useState } from 'react'
import { ImageOff, Loader2 } from 'lucide-react'
import type { X3FFileDTO } from '@shared/types'
import { previewUrl, type PreviewVariant } from '@shared/preview'
import { drawImageWithOrientation, shouldUseCanvas } from '../lib/orientation'
import { cn } from '../lib/cn'

type Status = 'loading' | 'ok' | 'error'

/** Centered spinner over a dim wash, shared by the importing + preview-loading states. */
function SpinnerOverlay(): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/40">
      <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
    </div>
  )
}

/**
 * Displays an X3F's embedded preview. The two variants are sourced and oriented
 * differently:
 *   - `full`    — the full-res JpgFromRaw, which embeds its *own* EXIF Orientation
 *                 and is already cropped to its final aspect ratio. It renders as a
 *                 plain lazy `<img>` and the browser orients it (image-orientation:
 *                 from-image). No manual rotation/crop — that would double-rotate it.
 *   - `preview` — the small 4:3 PreviewImage, which carries no orientation and
 *                 letterboxes non-4:3 crops. We fetch the bytes and bake the X3F's
 *                 EXIF rotation + the letterbox crop into a `<canvas>`.
 * Bytes come from the x3f-preview:// custom protocol.
 *
 * The media element fits inside the box via max-width/height + flex centering,
 * which works uniformly for both `<img>` and `<canvas>`.
 */
export function OrientedImage({
  file,
  variant = 'preview',
  containerClassName,
  className,
  maxEdge
}: {
  file: X3FFileDTO
  variant?: PreviewVariant
  containerClassName?: string
  className?: string
  maxEdge?: number
}): React.JSX.Element {
  const orientation = file.orientation ?? 1
  const aspectRatio = file.aspectRatio
  const url = previewUrl(file.path, variant)
  // While importing we don't yet know the orientation/crop, so hold off fetching
  // and just show a spinner; the row re-renders with the real preview once ready.
  const pending = file.pending ?? false

  // Only the small preview JPEG needs manual rotation/crop on a canvas; the
  // self-orienting, pre-cropped full-res JpgFromRaw renders as a plain <img>.
  const useCanvas = shouldUseCanvas(variant, orientation, aspectRatio)

  const [status, setStatus] = useState<Status>('loading')
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (pending) return // nothing to fetch yet; the spinner overlay is shown below
    setStatus('loading')
    if (!useCanvas) return // the <img> below drives its own load/error events

    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`preview ${res.status}`)
        // Canvas is only used for the small PreviewImage, which carries no EXIF
        // orientation, so the default decode gives raw pixels and we apply the
        // X3F's authoritative `orientation` ourselves. (The full-res JpgFromRaw
        // embeds its own EXIF and never reaches this path — it renders as an
        // <img> the browser orients; routing it here would double-rotate it.)
        const bitmap = await createImageBitmap(await res.blob())
        if (cancelled) {
          bitmap.close()
          return
        }
        const canvas = canvasRef.current
        if (canvas) drawImageWithOrientation(canvas, bitmap, orientation, { maxEdge, aspectRatio })
        bitmap.close()
        if (!cancelled) setStatus('ok')
      } catch {
        if (!cancelled) setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url, useCanvas, orientation, aspectRatio, maxEdge, pending])

  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden',
        containerClassName
      )}
    >
      {pending ? null : status === 'error' ? (
        <div className="flex h-full w-full items-center justify-center text-neutral-600">
          <ImageOff className="h-5 w-5" />
        </div>
      ) : useCanvas ? (
        <canvas
          ref={canvasRef}
          className={cn('max-h-full max-w-full', status === 'ok' ? 'opacity-100' : 'opacity-0', className)}
        />
      ) : (
        <img
          src={url}
          alt={file.fileName}
          loading="lazy"
          draggable={false}
          onLoad={() => setStatus('ok')}
          onError={() => setStatus('error')}
          className={cn(
            'max-h-full max-w-full transition-opacity',
            status === 'ok' ? 'opacity-100' : 'opacity-0',
            className
          )}
        />
      )}
      {(pending || status === 'loading') && <SpinnerOverlay />}
    </div>
  )
}
