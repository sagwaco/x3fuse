import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { Skeleton } from '@radix-ui/themes/components/skeleton'
import '@radix-ui/themes/src/components/skeleton.css'
import type { X3FFileDTO } from '@shared/types'
import { previewUrl, type PreviewVariant } from '@shared/preview'
import { drawImageWithOrientation, shouldUseCanvas } from '../lib/orientation'
import { cn } from '../lib/cn'
import { t } from '../lib/strings'
import { useDelayedLoading } from '../hooks/useDelayedLoading'

type Status = 'loading' | 'ok' | 'error'

// Retain only small, already-oriented canvases; full JPEGs use the webview's cache.
const canvasCache = new Map<string, HTMLCanvasElement>()
const CANVAS_BUDGET = 16 * 1024 * 1024
let cachedCanvasBytes = 0

function cacheCanvas(key: string, canvas: HTMLCanvasElement): void {
  const previous = canvasCache.get(key)
  if (previous) cachedCanvasBytes -= previous.width * previous.height * 4
  canvasCache.delete(key)
  canvasCache.set(key, canvas)
  cachedCanvasBytes += canvas.width * canvas.height * 4
  while (cachedCanvasBytes > CANVAS_BUDGET) {
    const oldest = canvasCache.keys().next().value!
    const evicted = canvasCache.get(oldest)!
    cachedCanvasBytes -= evicted.width * evicted.height * 4
    canvasCache.delete(oldest)
  }
}

interface ImageProps {
  file: X3FFileDTO
  variant?: PreviewVariant
  containerClassName?: string
  className?: string
  maxEdge?: number
  loading?: 'lazy' | 'eager'
  onLoad?: (image: HTMLImageElement) => void
}

/** Reset image state when its source changes, without resetting a full JPEG
 * when import metadata arrives: that JPEG carries its own orientation/crop. */
export function OrientedImage(props: ImageProps): React.JSX.Element {
  const { file, variant = 'preview', maxEdge } = props
  const key = JSON.stringify([
    file.id,
    file.path,
    variant,
    ...(variant === 'preview'
      ? [file.pending ?? false, file.orientation ?? 1, file.aspectRatio, maxEdge]
      : [])
  ])
  return <ImageContent key={key} cacheKey={key} {...props} />
}

function ImageContent({
  cacheKey,
  file,
  variant = 'preview',
  containerClassName,
  className,
  maxEdge,
  loading = 'lazy',
  onLoad
}: ImageProps & { cacheKey: string }): React.JSX.Element {
  const orientation = variant === 'preview' ? (file.orientation ?? 1) : 1
  const aspectRatio = variant === 'preview' ? file.aspectRatio : undefined
  const url = previewUrl(file.path, variant, file.id)
  // Small previews need metadata before they can be oriented and cropped.
  const pending = variant === 'preview' && !!file.pending
  const useCanvas = shouldUseCanvas(variant, orientation, aspectRatio)
  const [status, setStatus] = useState<Status>('loading')
  const [visible, setVisible] = useState(loading === 'eager')
  const showSkeleton = useDelayedLoading(pending || status === 'loading', cacheKey)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const mediaReady = useRef(false)

  const reportLoad = useCallback(
    (image: HTMLImageElement) => {
      if (mediaReady.current) return
      mediaReady.current = true
      setStatus('ok')
      onLoad?.(image)
    },
    [onLoad]
  )

  // Cached media must be ready before paint, including the parent's zoom sizing.
  useLayoutEffect(() => {
    if (pending || status !== 'loading') return
    if (!useCanvas) {
      const image = imageRef.current
      if (image?.complete && image.naturalWidth > 0) reportLoad(image)
      return
    }
    const cached = canvasCache.get(cacheKey)
    const canvas = canvasRef.current
    if (!cached || !canvas) return
    try {
      // StrictMode replays this effect; resizing the cached canvas itself clears it.
      if (cached !== canvas) {
        const context = canvas.getContext('2d')
        if (!context) throw new Error('no 2d context')
        canvas.width = cached.width
        canvas.height = cached.height
        context.drawImage(cached, 0, 0)
        cacheCanvas(cacheKey, canvas)
      }
      mediaReady.current = true
      setStatus('ok')
    } catch {
      setStatus('error')
    }
  }, [pending, status, useCanvas, cacheKey, reportLoad])

  useEffect(() => {
    if (!useCanvas || visible || loading === 'eager' || pending || mediaReady.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(containerRef.current!)
    return () => observer.disconnect()
  }, [useCanvas, visible, loading, pending])

  useEffect(() => {
    if (pending || !useCanvas || mediaReady.current || (!visible && loading !== 'eager')) return
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`preview ${res.status}`)
        const bitmap = await createImageBitmap(await res.blob())
        try {
          if (controller.signal.aborted) return
          const canvas = canvasRef.current
          if (!canvas?.getContext('2d')) throw new Error('no 2d context')
          drawImageWithOrientation(canvas, bitmap, orientation, { maxEdge, aspectRatio })
          cacheCanvas(cacheKey, canvas)
          mediaReady.current = true
          setStatus('ok')
        } finally {
          bitmap.close()
        }
      } catch {
        if (!controller.signal.aborted) setStatus('error')
      }
    })()
    return () => controller.abort()
  }, [url, useCanvas, orientation, aspectRatio, maxEdge, pending, visible, loading, cacheKey])

  return (
    <div
      ref={containerRef}
      aria-busy={pending || status === 'loading'}
      className={cn(
        'relative flex items-center justify-center overflow-hidden',
        containerClassName
      )}
    >
      {pending || status === 'error' ? null : useCanvas ? (
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={file.fileName}
          className={cn(
            'max-h-full max-w-full',
            status === 'ok' ? 'opacity-100' : 'opacity-0',
            className
          )}
        />
      ) : (
        <img
          ref={imageRef}
          src={url}
          alt={file.fileName}
          aria-hidden={variant === 'full' && status !== 'ok' ? true : undefined}
          loading={loading}
          decoding={variant === 'full' ? 'sync' : 'async'}
          draggable={false}
          onLoad={(event) => reportLoad(event.currentTarget)}
          onError={() => setStatus('error')}
          className={cn(
            'max-h-full max-w-full',
            status === 'ok' ? 'opacity-100' : 'opacity-0',
            className
          )}
        />
      )}
      {/* Avoid a brief low-res flash when the full JPEG loads within a second. */}
      {variant === 'full' && (showSkeleton || status === 'error') ? (
        <OrientedImage
          file={file}
          variant="preview"
          loading={loading}
          containerClassName="absolute inset-0"
          className={className}
          maxEdge={maxEdge}
        />
      ) : showSkeleton ? (
        <Skeleton className="preview-skeleton absolute inset-0 h-full w-full" />
      ) : status === 'error' ? (
        <div
          role="img"
          aria-label={t('inspector.no_preview')}
          className="flex h-full w-full items-center justify-center text-neutral-600"
        >
          <ImageOff className="h-5 w-5" />
        </div>
      ) : null}
    </div>
  )
}
