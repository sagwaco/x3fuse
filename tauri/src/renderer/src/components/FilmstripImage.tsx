import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { previewUrl } from '@shared/preview'
import { subscribeFitPreview } from '../lib/fitPreviews'
import { subscribeFullPreview } from '../lib/previewImages'
import { cn } from '../lib/cn'
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
  return <ImageContent key={JSON.stringify([props.file.id, props.file.path])} {...props} />
}

function ImageContent({
  file,
  fullResolution = false,
  onDimensions,
  containerClassName,
  className
}: Props): React.JSX.Element {
  const url = previewUrl(file.path, 'full', file.id)
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
