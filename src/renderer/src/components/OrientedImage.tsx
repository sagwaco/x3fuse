import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { Skeleton } from '@radix-ui/themes/components/skeleton'
import '@radix-ui/themes/src/components/skeleton.css'
import type { X3FFileDTO } from '@shared/types'
import { displayPreviewUrl, isRenderedPreview } from '@shared/preview'
import { cachedSmallPreview, loadSmallPreview, lookupSmallPreview } from '../lib/previewImages'
import { cn } from '../lib/cn'
import { t, useLanguage } from '../lib/strings'
import { useDelayedLoading } from '../hooks/useDelayedLoading'

type Status = 'loading' | 'ok' | 'error'
interface ImageProps {
  file: X3FFileDTO
  containerClassName?: string
  className?: string
  maxEdge?: number
  loading?: 'lazy' | 'eager'
  loadingDelay?: number
  /**
   * True shows the original while an edit loads. False shows only the pixels of
   * the current URL, as the minimap and the developing cloud need.
   */
  progressive?: boolean
  /** False only looks up a stored edit. Another view renders it. */
  render?: boolean
  /** Called when pixels first show, also the original of an edit. It gives no geometry. */
  onReady?: () => void
}

/** Milliseconds that a replacement crossfades with the previous pixels. */
const FADE_MS = 180
/** The unedited version of a photo, for its original preview. */
const originalFile = (file: X3FFileDTO): X3FFileDTO => ({
  ...file,
  edit: undefined,
  displayPreviewUrl: undefined
})

/** Shared, correctly oriented small preview for thumbnails and cold-load fallback. */
export function OrientedImage(props: ImageProps): React.JSX.Element {
  // A parent can cache this element, so this renders again for a new language.
  useLanguage()
  const { file, maxEdge, progressive = true } = props
  // Edits of the same source keep their pixels; a new source starts again.
  const key = JSON.stringify([
    file.path,
    file.pending ?? false,
    file.orientation ?? 1,
    file.aspectRatio,
    displayPreviewUrl(originalFile(file)),
    maxEdge,
    progressive ? null : [file.edit?.revision, displayPreviewUrl(file)]
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
  loadingDelay,
  progressive = true,
  render = true,
  onReady
}: ImageProps & { cacheKey: string }): React.JSX.Element {
  const edited = isRenderedPreview(file)
  const orientation = edited ? 1 : (file.orientation ?? 1)
  const aspectRatio = edited ? undefined : file.aspectRatio
  const url = displayPreviewUrl(file)
  const pending = !!file.pending
  const [status, setStatus] = useState<Status>('loading')
  const [visible, setVisible] = useState(loading === 'eager')
  // The front canvas shows `url`; the other one fades out under it, then clears.
  const [layer, setLayer] = useState<{ front: 0 | 1; url?: string; fading: boolean }>({
    front: 0,
    fading: false
  })
  const shown = useRef(layer)
  const showSkeleton = useDelayedLoading(pending || status === 'loading', cacheKey, loadingDelay)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvases = useRef<Array<HTMLCanvasElement | null>>([null, null])
  const settleFade = useRef<() => void>()
  const ready = useRef(onReady)
  ready.current = onReady

  const paint = useCallback(
    (source: HTMLCanvasElement, paintedUrl: string): void => {
      settleFade.current?.()
      const current = shown.current
      if (current.url === paintedUrl) return
      const replace = current.url !== undefined
      const front = (replace ? 1 - current.front : current.front) as 0 | 1
      const canvas = canvases.current[front]
      if (!canvas) return
      try {
        copyPreview(canvas, source, maxEdge)
      } catch {
        setStatus('error')
        return
      }
      canvas.dataset.previewUrl = paintedUrl
      const next = { front, url: paintedUrl, fading: replace }
      shown.current = next
      setLayer(next)
      setStatus('ok')
      if (!replace) return ready.current?.()
      const old = canvases.current[1 - front]
      const still = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      // Both layers fade, so the edges of another crop do not stay until the end.
      const animations = still
        ? []
        : [
            canvas.animate?.([{ opacity: 0 }, { opacity: 1 }], FADE_MS),
            old?.animate?.([{ opacity: 1 }, { opacity: 0 }], {
              duration: FADE_MS,
              fill: 'forwards'
            })
          ]
      // A timer ends the fade also in a hidden window, where animations can stop.
      const timer = setTimeout(() => settleFade.current?.(), animations[0] ? FADE_MS : 0)
      settleFade.current = () => {
        settleFade.current = undefined
        clearTimeout(timer)
        animations.forEach((animation) => animation?.cancel())
        if (old) {
          old.width = old.height = 0
          delete old.dataset.previewUrl
        }
        shown.current = { ...shown.current, fading: false }
        setLayer(shown.current)
      }
    },
    [maxEdge]
  )
  useEffect(() => () => settleFade.current?.(), [])

  // A decoded hit paints before the first paint.
  useLayoutEffect(() => {
    if (pending || shown.current.url === url) return
    const cached = cachedSmallPreview(url, orientation, aspectRatio)
    if (cached) paint(cached, url)
  }, [pending, url, orientation, aspectRatio, paint])

  useEffect(() => {
    if (visible || loading === 'eager' || pending || shown.current.url === url) return
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
  }, [visible, loading, pending, url])

  useEffect(() => {
    if (pending || shown.current.url === url || (!visible && loading !== 'eager')) return
    const controller = new AbortController()
    const { signal } = controller
    if (!shown.current.url) setStatus('loading')
    // An eager image shows the selected photo; lazy images are visible thumbnails.
    const priority = loading === 'eager' ? 'selected' : 'visible'
    const settle = (canvas: HTMLCanvasElement | undefined): boolean => {
      if (!canvas || signal.aborted) return false
      paint(canvas, url)
      return true
    }
    const empty = (): boolean => !signal.aborted && !shown.current.url
    const load = (): Promise<HTMLCanvasElement | undefined> =>
      render || !edited
        ? loadSmallPreview(url, orientation, aspectRatio, signal, priority)
        : lookupSmallPreview(url, orientation, aspectRatio, signal)

    if (!edited || !progressive || shown.current.url) {
      void load()
        .then((canvas) => {
          if (!settle(canvas) && !signal.aborted) setStatus('error')
        })
        .catch(() => {
          if (!signal.aborted) setStatus('error')
        })
      return () => controller.abort()
    }

    // An edit: the stored edit goes first. The original shows only after a miss and
    // only while no edited pixels show.
    const spare = new AbortController()
    signal.addEventListener('abort', () => spare.abort(), { once: true })
    const original = originalFile(file)
    const originalUrl = displayPreviewUrl(original)
    const backup = loadSmallPreview(
      originalUrl,
      original.orientation ?? 1,
      original.aspectRatio,
      spare.signal,
      priority
    ).catch(() => undefined)
    void (async () => {
      const stored = await lookupSmallPreview(url, 1, undefined, signal).catch(() => undefined)
      if (signal.aborted) return
      if (settle(stored)) return spare.abort()
      void backup.then((canvas) => {
        if (canvas && empty()) paint(canvas, originalUrl)
      })
      const next = render
        ? await loadSmallPreview(url, 1, undefined, signal, priority).catch(() => undefined)
        : undefined
      if (settle(next)) return spare.abort()
      const fallback = await backup
      if (!signal.aborted && (render || !fallback)) setStatus('error')
    })()
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, orientation, aspectRatio, pending, visible, loading, edited, progressive, render, paint])

  const canvas = (index: 0 | 1): React.JSX.Element => {
    const front = index === layer.front
    return (
      <canvas
        key={index}
        ref={(element) => {
          canvases.current[index] = element
        }}
        role={front ? 'img' : undefined}
        aria-label={front ? file.fileName : undefined}
        aria-hidden={front ? undefined : true}
        className={cn(
          'max-h-full max-w-full',
          // The front canvas keeps the intrinsic layout; the other one stacks under it.
          front ? 'relative z-[1]' : 'absolute inset-0 m-auto',
          front
            ? layer.url
              ? 'opacity-100'
              : status === 'error'
                ? 'hidden'
                : 'opacity-0'
            : !layer.fading && 'hidden',
          className
        )}
      />
    )
  }

  return (
    <div
      ref={containerRef}
      aria-busy={pending || (layer.url !== url && status !== 'error')}
      className={cn(
        'relative flex items-center justify-center overflow-hidden',
        containerClassName
      )}
    >
      {!pending && [canvas(0), canvas(1)]}
      {showSkeleton ? (
        <Skeleton className="preview-skeleton absolute inset-0 h-full w-full" />
      ) : status === 'error' && !layer.url ? (
        <div
          role="img"
          aria-label={t('inspector.no_preview')}
          className="flex h-full w-full items-center justify-center text-tone-600"
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
