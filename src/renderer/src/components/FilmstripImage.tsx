import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { X3FFileDTO } from '@shared/types'
import type { PreviewRegion } from '@shared/editor'
import { displayPreviewUrl, isRenderedPreview } from '@shared/preview'
import { subscribeFitPreview } from '../lib/fitPreviews'
import { cachedFullPreview, subscribeFullPreview } from '../lib/previewImages'
import { loadFrame } from '../lib/frames'
import { cn } from '../lib/cn'
import { OrientedImage } from './OrientedImage'

interface Props {
  file: X3FFileDTO
  fullResolution?: boolean
  region?: PreviewRegion | null
  /** Allow full-size saved renders in the library. Live editor frames use tiles. */
  nativePreview?: boolean
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
  region,
  nativePreview = false,
  onDimensions,
  containerClassName,
  className
}: Props): React.JSX.Element {
  const url = displayPreviewUrl(file, 'full')
  const edited = isRenderedPreview(file)
  // Until its import resolves, a row can be an edited photo; do not show its original.
  const pending = !!file.pending && !edited
  const fullUrl = useMemo(() => {
    if (!nativePreview || file.displayPreviewUrl || !url) return url
    const native = new URL(url)
    native.searchParams.set('v', 'native')
    return native.toString()
  }, [nativePreview, file.displayPreviewUrl, url])
  const overlay =
    fullResolution && (!edited || nativePreview) && !file.displayPreviewUrl && !pending && !!fullUrl
  const regionUrl = useMemo(() => {
    if (!overlay || !nativePreview || !region) return undefined
    const uri = new URL(fullUrl)
    if (edited) uri.searchParams.set('v', 'region')
    uri.searchParams.set('region', [region.x, region.y, region.width, region.height].join(','))
    return uri.toString()
  }, [overlay, nativePreview, region, fullUrl, edited])
  const detail = useRef<HTMLCanvasElement>(null)
  const [detailReady, setDetailReady] = useState<string>()
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
  const [fullSource, setFullSource] = useState<{ url: string; source: string }>()
  const source = fullSource?.url === fullUrl ? fullSource.source : undefined
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
    if (!regionUrl || !region) return
    // A stored whole image needs no new region render.
    if (cachedFullPreview(fullUrl)) {
      setDetailReady(regionUrl)
      return
    }
    const controller = new AbortController()
    void loadFrame(regionUrl, controller.signal, 'high')
      .then((frame) => {
        try {
          const element = detail.current
          const context = element?.getContext('2d')
          if (controller.signal.aborted || !element || !context) return
          element.width = frame.width
          element.height = frame.height
          context.drawImage(frame.image, 0, 0)
          const bounds = frame.region ?? region
          Object.assign(element.style, {
            left: `${bounds.x * 100}%`,
            top: `${bounds.y * 100}%`,
            width: `${bounds.width * 100}%`,
            height: `${bounds.height * 100}%`
          })
          element.dataset.previewUrl = regionUrl
          setDetailReady(regionUrl)
        } finally {
          frame.release()
        }
      })
      .catch(() => {
        // A failed region falls back to the whole preview.
        if (!controller.signal.aborted) setDetailReady(regionUrl)
      })
    return () => controller.abort()
  }, [regionUrl, region, fullUrl])

  useEffect(() => {
    if (!overlay || (regionUrl && detailReady !== regionUrl)) return
    let release: (() => void) | undefined
    const start = (): void => {
      release = subscribeFullPreview(
        fullUrl,
        (next) => setFullSource({ url: fullUrl, source: next }),
        () => setFullReady(undefined),
        regionUrl ? 'background' : 'foreground'
      )
    }
    // Give navigation a quiet interval before starting a whole RAW render.
    if (!regionUrl || cachedFullPreview(fullUrl)) start()
    const timer = release ? undefined : setTimeout(start, 1000)
    return () => {
      clearTimeout(timer)
      release?.()
    }
  }, [fullUrl, overlay, regionUrl, detailReady])

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
      {regionUrl && (
        <canvas
          key={fullUrl}
          ref={detail}
          data-preview-region
          aria-hidden="true"
          className="absolute"
        />
      )}
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
            className,
            // The image bounds set the aspect ratio. WebKit can squash large JPEGs with contain.
            'object-fill'
          )}
          onError={() => setFullReady(undefined)}
        />
      )}
    </div>
  )
}
