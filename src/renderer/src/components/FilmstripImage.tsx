import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { displayPreviewUrl, isRenderedPreview } from '@shared/preview'
import { subscribeFitPreview } from '../lib/fitPreviews'
import { subscribeFullPreview } from '../lib/previewImages'
import { cn } from '../lib/cn'
import { OrientedImage } from './OrientedImage'

interface Props {
  file: X3FFileDTO
  fullResolution?: boolean
  /** Gets the size and the url of each picture when its pixels are on the canvas. */
  onDimensions?: (dimensions: { width: number; height: number }, url: string) => void
  containerClassName?: string
  className?: string
}

/** Milliseconds that the first Fit image fades in over its thumbnail. */
const FADE_MS = 180

/**
 * Keep the decoded Fit canvas in place throughout every full-resolution upgrade.
 * Edits, a first save and a reset of the same photo keep its previous pixels.
 */
export function FilmstripImage(props: Props): React.JSX.Element {
  const { id, path, previewRevision } = props.file
  return <Content key={JSON.stringify([id, path, previewRevision])} {...props} />
}

function Content({
  file,
  fullResolution = false,
  onDimensions,
  containerClassName,
  className
}: Props): React.JSX.Element {
  const url = displayPreviewUrl(file, 'full')
  const edited = isRenderedPreview(file)
  // Until its import resolves, a row can be an edited photo; do not show its original.
  const pending = !!file.pending && !edited
  const overlay = fullResolution && !edited && !pending
  const canvas = useRef<HTMLCanvasElement>(null)
  const fallback = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const dimensions = useRef(onDimensions)
  dimensions.current = onDimensions
  const fallbackShown = useRef(false)
  const settleFade = useRef<() => void>()
  /** The URL of the Fit pixels on the canvas. */
  const [shown, setShown] = useState<string>()
  const [failed, setFailed] = useState<string>()
  const [fadingIn, setFadingIn] = useState(false)
  const [source, setSource] = useState<string>()
  const [fullReady, setFullReady] = useState<{ source: string; element: HTMLImageElement }>()
  useEffect(() => () => settleFade.current?.(), [])

  // A decoded cache hit copies immediately, before this file's first paint.
  // Only the Fit image gives geometry; the small fallback has other dimensions.
  useLayoutEffect(
    () =>
      pending
        ? undefined
        : subscribeFitPreview(
            url,
            (preview) => {
              const element = canvas.current
              const context = element?.getContext('2d')
              if (!element || !context) return
              settleFade.current?.()
              const still = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
              const replacing = element.dataset.previewUrl !== undefined
              element.width = preview.image.width
              element.height = preview.image.height
              context.drawImage(preview.image, 0, 0)
              element.dataset.previewUrl = url
              dimensions.current?.({ width: preview.width, height: preview.height }, url)
              setShown(url)
              // Live edit frames stay opaque; only the first thumbnail handoff fades.
              const outgoing =
                !replacing && !still && fallbackShown.current ? fallback.current : null
              if (!outgoing) return
              setFadingIn(true)
              const animations = [
                element.animate?.([{ opacity: 0 }, { opacity: 1 }], FADE_MS),
                outgoing.animate?.([{ opacity: 1 }, { opacity: 0 }], {
                  duration: FADE_MS,
                  fill: 'forwards'
                })
              ]
              // A timer ends the fade also in a hidden window, where animations can stop.
              const timer = setTimeout(() => settleFade.current?.(), FADE_MS)
              settleFade.current = () => {
                settleFade.current = undefined
                clearTimeout(timer)
                outgoing.style.opacity = '0'
                for (const animation of animations) animation?.cancel()
                setFadingIn(false)
              }
            },
            // Keep the previous pixels or the fallback, and end the busy state.
            () => setFailed(url)
          ),
    [url, pending]
  )

  useEffect(() => {
    if (!overlay) return
    return subscribeFullPreview(
      url,
      (next) => {
        setSource(next)
      },
      () => setFullReady(undefined)
    )
  }, [url, overlay])

  // load/complete alone do not guarantee decoded pixels when decoding is async.
  // The medium canvas stays underneath even after the overlay is revealed.
  useEffect(() => {
    if (!overlay || !source) return
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
  }, [source, overlay])

  const fitReady = shown !== undefined
  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden',
        containerClassName
      )}
      aria-busy={shown !== url && failed !== url}
    >
      {(!fitReady || fadingIn) && (
        // An edit shows only its stored thumbnail, else the original. It does not
        // render a small edit that competes with the Fit render.
        <div ref={fallback} className="absolute inset-0">
          <OrientedImage
            file={file}
            loading="eager"
            loadingDelay={500}
            render={false}
            onReady={() => {
              fallbackShown.current = true
            }}
            containerClassName="h-full w-full"
            className={className}
          />
        </div>
      )}
      <canvas
        ref={canvas}
        data-fit-preview
        data-rendered-preview={edited || undefined}
        role="img"
        aria-label={file.fileName}
        aria-hidden={!fitReady || undefined}
        className={cn(
          'relative max-h-full max-w-full',
          fitReady ? 'opacity-100' : 'opacity-0',
          className
        )}
      />
      {overlay && source && (
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
