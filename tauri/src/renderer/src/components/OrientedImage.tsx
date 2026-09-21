import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { Skeleton } from '@radix-ui/themes/components/skeleton'
import '@radix-ui/themes/src/components/skeleton.css'
import type { X3FFileDTO } from '@shared/types'
import { displayPreviewUrl, isRenderedPreview } from '@shared/preview'
import { cachedSmallPreview, loadSmallPreview } from '../lib/previewImages'
import { cn } from '../lib/cn'
import { t } from '../lib/strings'
import { useDelayedLoading } from '../hooks/useDelayedLoading'

type Status = 'loading' | 'ok' | 'error'
interface ImageProps {
  file: X3FFileDTO
  containerClassName?: string
  className?: string
  maxEdge?: number
  loading?: 'lazy' | 'eager'
  loadingDelay?: number
}

/** Shared, correctly oriented small preview for thumbnails and cold-load fallback. */
export function OrientedImage(props: ImageProps): React.JSX.Element {
  const { file, maxEdge } = props
  const key = JSON.stringify([
    file.id,
    file.path,
    file.pending ?? false,
    file.orientation ?? 1,
    file.aspectRatio,
    file.displayPreviewUrl,
    file.edit?.revision,
    file.edit?.previewUrl,
    maxEdge
  ])
  return <ImageContent key={key} cacheKey={key} {...props} />
}

function ImageContent({
  cacheKey,
  file,
  containerClassName,
  className,
  maxEdge,
  loading = 'lazy',
  loadingDelay
}: ImageProps & { cacheKey: string }): React.JSX.Element {
  const orientation = isRenderedPreview(file) ? 1 : (file.orientation ?? 1)
  const aspectRatio = isRenderedPreview(file) ? undefined : file.aspectRatio
  const url = displayPreviewUrl(file)
  const pending = !!file.pending
  const [status, setStatus] = useState<Status>('loading')
  const [visible, setVisible] = useState(loading === 'eager')
  const showSkeleton = useDelayedLoading(pending || status === 'loading', cacheKey, loadingDelay)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mediaReady = useRef(false)

  useLayoutEffect(() => {
    if (pending || mediaReady.current) return
    const cached = cachedSmallPreview(url, orientation, aspectRatio)
    const canvas = canvasRef.current
    if (!cached || !canvas) return
    try {
      copyPreview(canvas, cached, maxEdge)
      mediaReady.current = true
      setStatus('ok')
    } catch {
      setStatus('error')
    }
  }, [pending, url, orientation, aspectRatio, maxEdge])

  useEffect(() => {
    if (visible || loading === 'eager' || pending || mediaReady.current) return
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
  }, [visible, loading, pending])

  useEffect(() => {
    if (pending || mediaReady.current || (!visible && loading !== 'eager')) return
    const controller = new AbortController()
    void loadSmallPreview(url, orientation, aspectRatio, controller.signal)
      .then((cached) => {
        if (controller.signal.aborted || !canvasRef.current) return
        copyPreview(canvasRef.current, cached, maxEdge)
        mediaReady.current = true
        setStatus('ok')
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('error')
      })
    return () => controller.abort()
  }, [url, orientation, aspectRatio, maxEdge, pending, visible, loading])

  return (
    <div
      ref={containerRef}
      aria-busy={pending || status === 'loading'}
      className={cn(
        'relative flex items-center justify-center overflow-hidden',
        containerClassName
      )}
    >
      {!pending && status !== 'error' && (
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
      )}
      {showSkeleton ? (
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

function copyPreview(canvas: HTMLCanvasElement, source: HTMLCanvasElement, maxEdge = 1800): void {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No preview canvas')
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height))
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
}
