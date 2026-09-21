import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Skeleton } from '@radix-ui/themes/components/skeleton'
import '@radix-ui/themes/src/components/skeleton.css'
import type { X3FFileDTO } from '@shared/types'
import { displayPreviewUrl, isRenderedPreview } from '@shared/preview'
import { t } from '../lib/strings'
import { subscribeFitPreview } from '../lib/fitPreviews'
import { subscribeFullPreview } from '../lib/previewImages'
import { cn } from '../lib/cn'
import { useDelayedLoading } from '../hooks/useDelayedLoading'
import { OrientedImage } from './OrientedImage'

interface Props {
  file: X3FFileDTO
  fullResolution?: boolean
  onDimensions?: (dimensions: { width: number; height: number }) => void
  containerClassName?: string
  className?: string
}

/** Keep the decoded Fit canvas in place throughout every full-resolution upgrade. */
export function FilmstripImage(props: Props): React.JSX.Element {
  const Content = isRenderedPreview(props.file) ? RenderedContent : ImageContent
  return <Content key={JSON.stringify([props.file.id, props.file.path])} {...props} />
}

/** Editor frames share the decoded Fit cache and keep their previous pixels during upgrades. */
function RenderedContent({
  file,
  onDimensions,
  containerClassName,
  className
}: Props): React.JSX.Element {
  const url = displayPreviewUrl(file, 'full')
  const canvas = useRef<HTMLCanvasElement>(null)
  const dimensions = useRef(onDimensions)
  dimensions.current = onDimensions
  const [ready, setReady] = useState(false)
  const [failedUrl, setFailedUrl] = useState<string>()
  const failed = failedUrl === url
  const showSkeleton = useDelayedLoading(!ready && !failed, url, 500)
  useLayoutEffect(() => {
    setFailedUrl(undefined)
    return subscribeFitPreview(
      url,
      (preview) => {
        const element = canvas.current
        const context = element?.getContext('2d')
        if (!element || !context) return
        element.width = preview.image.width
        element.height = preview.image.height
        context.drawImage(preview.image, 0, 0)
        element.dataset.previewUrl = url
        dimensions.current?.({ width: preview.width, height: preview.height })
        setReady(true)
        setFailedUrl(undefined)
      },
      () => setFailedUrl(url)
    )
  }, [url])
  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden',
        containerClassName
      )}
      aria-busy={!ready && !failed}
    >
      <canvas
        ref={canvas}
        data-fit-preview
        data-rendered-preview
        role="img"
        aria-label={file.fileName}
        aria-hidden={!ready || undefined}
        className={cn('max-h-full max-w-full', ready ? 'opacity-100' : 'opacity-0', className)}
      />
      {showSkeleton ? (
        <Skeleton className="preview-skeleton absolute inset-0 h-full w-full" />
      ) : failed && !ready ? (
        <span role="alert" className="absolute text-xs text-neutral-500">
          {t('inspector.no_preview')}
        </span>
      ) : null}
    </div>
  )
}

function ImageContent({
  file,
  fullResolution = false,
  onDimensions,
  containerClassName,
  className
}: Props): React.JSX.Element {
  const url = displayPreviewUrl(file, 'full')
  const canvas = useRef<HTMLCanvasElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const dimensions = useRef(onDimensions)
  dimensions.current = onDimensions
  const [fitReady, setFitReady] = useState(false)
  const [source, setSource] = useState<string>()
  const [fullReady, setFullReady] = useState<{ source: string; element: HTMLImageElement }>()

  // A decoded cache hit copies immediately, before this file's first paint.
  useLayoutEffect(
    () =>
      subscribeFitPreview(
        url,
        (preview) => {
          const element = canvas.current
          const context = element?.getContext('2d')
          if (!element || !context) return
          element.width = preview.image.width
          element.height = preview.image.height
          context.drawImage(preview.image, 0, 0)
          dimensions.current?.({ width: preview.width, height: preview.height })
          setFitReady(true)
        },
        () => {}
      ),
    [url]
  )

  useEffect(() => {
    if (!fullResolution) return
    return subscribeFullPreview(
      url,
      (next) => {
        setSource(next)
      },
      () => setFullReady(undefined)
    )
  }, [url, fullResolution])

  // load/complete alone do not guarantee decoded pixels when decoding is async.
  // The medium canvas stays underneath even after the overlay is revealed.
  useEffect(() => {
    if (!fullResolution || !source) return
    const element = image.current
    if (!element) return
    let cancelled = false
    setFullReady(undefined)
    void element
      .decode()
      .then(() => {
        if (!cancelled && image.current === element) {
          setFullReady({ source, element })
        }
      })
      .catch(() => {
        // Keep the same decoded Fit image on an unavailable/cancelled full preview.
      })
    return () => {
      cancelled = true
    }
  }, [source, fullResolution])

  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden',
        containerClassName
      )}
      aria-busy={!fitReady}
    >
      {!fitReady && (
        <OrientedImage
          file={file}
          loading="eager"
          loadingDelay={500}
          containerClassName="absolute inset-0"
          className={className}
        />
      )}
      <canvas
        ref={canvas}
        data-fit-preview
        role="img"
        aria-label={file.fileName}
        aria-hidden={!fitReady || undefined}
        className={cn('max-h-full max-w-full', fitReady ? 'opacity-100' : 'opacity-0', className)}
      />
      {fullResolution && source && (
        <img
          ref={image}
          data-full-preview
          src={source}
          alt=""
          aria-hidden="true"
          decoding="async"
          draggable={false}
          className={cn(
            'absolute inset-0 max-h-full max-w-full',
            fullReady?.source === source && fullReady.element === image.current
              ? 'opacity-100'
              : 'opacity-0',
            className
          )}
          onError={() => setFullReady(undefined)}
        />
      )}
    </div>
  )
}
