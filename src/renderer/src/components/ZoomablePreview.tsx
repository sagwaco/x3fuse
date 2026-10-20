import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { t } from '../lib/strings'
import { FilmstripImage } from './FilmstripImage'
import { usePreviewStore } from '../stores/previewStore'
import type { PreviewRegion } from '@shared/editor'
import type { PreviewCache } from '../lib/previewTiles'
import { loadFrame } from '../lib/frames'

type View = { zoom: number | null; x: number; y: number }
type ZoomOptions = { x?: number; y?: number; animate?: boolean; center?: boolean }
const FIT: View = { zoom: null, x: 0, y: 0 }
const MAX_ZOOM = 8
type Tile = { url: string; region: PreviewRegion; viewport: PreviewRegion }
type CacheLoad = { url: string; x: number; y: number; onMiss?: (url: string) => void }
const CACHE_LOADS = 4
/** Milliseconds a view stays still before it goes to the renderer. */
const REST = 120
/** The same after an eased zoom, which runs for 240 ms in CSS. */
const EASED_REST = 260
/** Screen pixels that an arrow key moves or sizes a selection. */
const KEY_STEP = 8
const ARROWS: Partial<Record<string, [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
}
const clamp = (value: number): number => Math.max(0, Math.min(1, value))
/** The rectangle of a key selection, inside the image. */
function markerRegion({ x, y, width, height }: PreviewRegion): PreviewRegion {
  const left = clamp(x - width / 2)
  const top = clamp(y - height / 2)
  return {
    x: left,
    y: top,
    width: clamp(x + width / 2) - left,
    height: clamp(y + height / 2) - top
  }
}

/** Zoom is relative to the oriented JPEG's natural dimensions; null follows Fit. */
export function ZoomablePreview({
  file,
  onImagePoint,
  onImageRegion,
  outline,
  selectionKey,
  naturalSize,
  tile,
  cache,
  onCacheMiss,
  onViewportChange,
  onViewportMove,
  onPaint,
  onSelectionCancel,
  digitZoom = true
}: {
  file: X3FFileDTO
  /** Gets a clicked point, 0 to 1 of the image. */
  onImagePoint?: (x: number, y: number) => void
  /** Gets a dragged rectangle, 0 to 1 of the image. A drag then selects instead of panning. */
  onImageRegion?: (region: PreviewRegion) => void
  /** A rectangle, 0 to 1 of the image, to show as a dashed outline. */
  outline?: PreviewRegion | null
  /** Names the picture that selections are made on. A change ends a selection in progress. */
  selectionKey?: string | null
  naturalSize?: { width: number; height: number }
  tile?: Tile | null
  /**
   * Sharp renders of the current recipe around the viewport. They go over
   * `tile`, which can still show an older recipe until its replacement decodes.
   */
  cache?: PreviewCache | null
  onCacheMiss?: (url: string) => void
  /** Gets the visible region when a new picture shows and when the view rests. */
  onViewportChange?: (region: PreviewRegion | null) => void
  /** Called for each change of a view that has not rested yet. */
  onViewportMove?: () => void
  /** Called after the image paints its pixels, with their url and size. */
  onPaint?: (url: string, size: { width: number; height: number }) => void
  /** Called when Escape ends a selection in progress. */
  onSelectionCancel?: () => void
  /** False leaves 0 and 1 for other shortcuts, such as star ratings. */
  digitZoom?: boolean
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLDivElement>(null)
  const animateZoom = useRef(false)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const moved = useRef(false)
  const [dragging, setDragging] = useState(false)
  // The start point and the current rectangle of a region drag.
  const select = useRef<{ x: number; y: number; region?: PreviewRegion } | null>(null)
  const [band, setBand] = useState<PreviewRegion | null>(null)
  // A selection by keys: its center and its size, 0 to 1 of the image.
  const [marker, setMarker] = useState<PreviewRegion | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [loaded, setLoaded] = useState({ width: 0, height: 0 })
  // Known dimensions apply in the same render as the picture they belong to.
  const naturalWidth = naturalSize?.width ?? 0
  const naturalHeight = naturalSize?.height ?? 0
  const image = useMemo(
    () => (naturalWidth && naturalHeight ? { width: naturalWidth, height: naturalHeight } : loaded),
    [naturalWidth, naturalHeight, loaded]
  )
  const [view, setView] = useState<View>(FIT)
  const latestView = useRef<View>(FIT)
  const frame = useRef<number | null>(null)
  const ready = image.width > 0 && image.height > 0 && size.width > 0 && size.height > 0
  const fit = ready ? Math.min(1, size.width / image.width, size.height / image.height) : 1
  const minZoom = Math.min(0.1, fit)

  useEffect(() => {
    const viewport = viewportRef.current!
    const observer = new ResizeObserver(([entry]) => {
      animateZoom.current = false
      const { width, height } = entry.contentRect
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      )
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const constrain = useCallback(
    (next: View): View => {
      const scale = next.zoom ?? fit
      const maxX = Math.max(0, (image.width * scale - size.width) / 2)
      const maxY = Math.max(0, (image.height * scale - size.height) / 2)
      const x = Math.max(-maxX, Math.min(maxX, next.x))
      const y = Math.max(-maxY, Math.min(maxY, next.y))
      return x === next.x && y === next.y ? next : { ...next, x, y }
    },
    [fit, image, size]
  )

  const flushView = useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    setView(latestView.current)
  }, [])

  // Accumulate every gesture delta, but publish at most once per display frame.
  const updateView = useCallback(
    (next: View, deferred = false): void => {
      const previous = latestView.current
      const changed = previous.zoom !== next.zoom || previous.x !== next.x || previous.y !== next.y
      if (changed) latestView.current = next
      if (!deferred) flushView()
      else if (changed && frame.current === null) frame.current = requestAnimationFrame(flushView)
    },
    [flushView]
  )

  // Clamp stored offsets too, so resizing away an edge cannot resurrect an old pan.
  useEffect(() => updateView(constrain(latestView.current)), [constrain, updateView])

  // Read the presentation once when a gesture interrupts an eased zoom. All
  // animation frames stay in the compositor, without React/store updates.
  const interruptZoom = useCallback((): View | null => {
    if (!animateZoom.current) return null
    animateZoom.current = false
    const media = mediaRef.current
    if (!media || media.getAnimations().length === 0) return null
    const matrix = new DOMMatrixReadOnly(getComputedStyle(media).transform)
    return { zoom: matrix.a, x: matrix.e, y: matrix.f }
  }, [])

  const zoomTo = useCallback(
    (
      target: number | null | ((scale: number) => number),
      { x = 0, y = 0, animate = true, center = false }: ZoomOptions = {}
    ): void => {
      if (!ready) return
      const presented = animate ? null : interruptZoom()
      animateZoom.current = animate
      const current = constrain(presented ?? latestView.current)
      const oldScale = current.zoom ?? fit
      const requested = typeof target === 'function' ? target(oldScale) : target
      if (requested === null) {
        updateView(FIT)
        return
      }
      const zoom = Math.max(minZoom, Math.min(MAX_ZOOM, requested))
      const ratio = zoom / oldScale
      updateView(
        constrain({
          zoom,
          x: (center ? 0 : x) - (x - current.x) * ratio,
          y: (center ? 0 : y) - (y - current.y) * ratio
        }),
        !animate
      )
    },
    [ready, constrain, fit, minZoom, interruptZoom, updateView]
  )

  const pan = useCallback(
    (x: number, y: number): void => {
      const presented = interruptZoom()
      const current = constrain(presented ?? latestView.current)
      updateView(constrain({ ...current, x: current.x + x, y: current.y + y }), true)
    },
    [constrain, interruptZoom, updateView]
  )

  useEffect(() => {
    const viewport = viewportRef.current!
    const wheel = (event: WheelEvent): void => {
      // Chromium sends trackpad pinches as ctrl+wheel. A native non-passive
      // listener prevents the gesture from zooming the entire application window.
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1
      if (event.ctrlKey) {
        const rect = viewport.getBoundingClientRect()
        zoomTo((scale) => scale * Math.exp(-event.deltaY * unit * 0.01), {
          x: event.clientX - rect.left - rect.width / 2,
          y: event.clientY - rect.top - rect.height / 2,
          animate: false
        })
      } else {
        pan(-event.deltaX * unit, -event.deltaY * unit)
      }
    }
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => viewport.removeEventListener('wheel', wheel)
  }, [pan, zoomTo, size.height])

  const current = constrain(view)
  const scale = current.zoom ?? fit
  const canPan = ready && scale > fit
  const panTo = useCallback(
    (centerX: number, centerY: number): void => {
      const presented = interruptZoom()
      const current = constrain(presented ?? latestView.current)
      const scale = current.zoom ?? fit
      updateView(
        constrain({
          ...current,
          x: (0.5 - centerX) * image.width * scale,
          y: (0.5 - centerY) * image.height * scale
        })
      )
    },
    [constrain, image, fit, interruptZoom, updateView]
  )

  const visibleRegion = useMemo(() => {
    if (!canPan) return null
    const width = Math.min(1, size.width / (image.width * scale))
    const height = Math.min(1, size.height / (image.height * scale))
    return {
      x: Math.max(0, Math.min(1 - width, 0.5 - current.x / (image.width * scale) - width / 2)),
      y: Math.max(0, Math.min(1 - height, 0.5 - current.y / (image.height * scale) - height / 2)),
      width,
      height
    }
  }, [canPan, image, size, scale, current.x, current.y])

  // A new picture gets its viewport before paint. A moving view sends it when
  // the view rests: a render for each gesture frame keeps the GPU busy, and the
  // compositor then skips frames.
  const published = useRef<string | null | undefined>(null)
  const move = useRef(onViewportMove)
  move.current = onViewportMove
  useLayoutEffect(() => {
    if (published.current !== file.displayPreviewUrl) {
      published.current = file.displayPreviewUrl
      onViewportChange?.(visibleRegion)
      return
    }
    move.current?.()
    const timer = setTimeout(
      () => onViewportChange?.(visibleRegion),
      animateZoom.current ? EASED_REST : REST
    )
    return () => clearTimeout(timer)
  }, [onViewportChange, visibleRegion, file.displayPreviewUrl])

  useEffect(() => {
    usePreviewStore.setState({
      minimap: visibleRegion
        ? {
            fileId: file.id,
            aspectRatio: image.width / image.height,
            ...visibleRegion,
            panTo
          }
        : null
    })
  }, [visibleRegion, file.id, image, panTo])

  useEffect(() => {
    usePreviewStore.setState({
      controls: ready
        ? {
            fileId: file.id,
            zoom: current.zoom,
            scale,
            minZoom,
            maxZoom: MAX_ZOOM,
            zoomTo
          }
        : null
    })
  }, [ready, file.id, current.zoom, scale, minZoom, zoomTo])

  useLayoutEffect(() => {
    usePreviewStore.setState({ activeFileId: file.id })
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      if (usePreviewStore.getState().activeFileId === file.id) {
        usePreviewStore.setState({ activeFileId: null, minimap: null, controls: null })
      }
    }
  }, [file.id])

  const stopDragging = (): void => {
    flushView()
    drag.current = null
    select.current = null
    setDragging(false)
    setBand(null)
  }

  /** A client point as a fraction of the displayed image, which can be outside 0 to 1. */
  const imagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = mediaRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return null
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height }
  }
  // Ends a selection by keys or by pointer without a report. A pointer that is still
  // down then neither pans nor clicks.
  const cancelSelection = useCallback((): void => {
    if (select.current) {
      moved.current = true
      drag.current = null
      select.current = null
    }
    setBand(null)
    setMarker(null)
  }, [])
  // A selection ends without a report when the mode ends or the picture changes, as when
  // a frame of other geometry paints during a drag.
  const armed = !!onImageRegion
  useEffect(cancelSelection, [armed, selectionKey, cancelSelection])

  const onDimensions = useCallback(({ width, height }: { width: number; height: number }): void => {
    setLoaded((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height }
    )
  }, [])
  const paint = useRef(onPaint)
  paint.current = onPaint
  const painted = useCallback(
    (size: { width: number; height: number }, url: string): void => {
      onDimensions(size)
      paint.current?.(url, size)
    },
    [onDimensions]
  )
  const fullResolution = ready && scale > fit
  // The rectangle being dragged or moved by keys, else the given one, in image pixels.
  // A point shows as a square of 8 screen pixels.
  const shown = band ?? (marker && markerRegion(marker)) ?? outline
  const dot = 4 / scale
  const box = shown && {
    x: shown.x * image.width - (shown.width ? 0 : dot),
    y: shown.y * image.height - (shown.height ? 0 : dot),
    width: shown.width * image.width || 2 * dot,
    height: shown.height * image.height || 2 * dot,
    fill: 'none'
  }
  const content = useMemo(
    () => (
      <FilmstripImage
        file={file}
        fullResolution={fullResolution}
        containerClassName="h-full w-full"
        className="h-full w-full object-contain"
        onDimensions={painted}
      />
    ),
    [file, fullResolution, painted]
  )

  return (
    <div className="relative h-full w-full min-h-0 min-w-0">
      <div
        ref={viewportRef}
        role="region"
        aria-label={t('preview.image')}
        tabIndex={0}
        className="absolute inset-0 overflow-hidden overscroll-none outline-none"
        style={{
          cursor: onImagePoint
            ? 'crosshair'
            : dragging
              ? 'grabbing'
              : canPan
                ? 'grab'
                : ready
                  ? 'zoom-in'
                  : 'default',
          touchAction: 'none'
        }}
        onClick={(event) => {
          if (onImagePoint && !moved.current) {
            const point = imagePoint(event.clientX, event.clientY)
            if (point && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
              onImagePoint(point.x, point.y)
            return
          }
          if (!moved.current) {
            const rect = event.currentTarget.getBoundingClientRect()
            zoomTo((latestView.current.zoom ?? fit) === fit && fit < 1 ? 1 : null, {
              x: event.detail ? event.clientX - rect.left - rect.width / 2 : 0,
              y: event.detail ? event.clientY - rect.top - rect.height / 2 : 0,
              center: true
            })
          }
          moved.current = false
        }}
        onKeyDown={(event) => {
          // Keys select as a pointer does: arrow keys move a point, Shift with arrow keys
          // sizes a rectangle around it, Return applies it, and Escape cancels.
          const arrow = ARROWS[event.key]
          const plain = !event.metaKey && !event.ctrlKey && !event.altKey
          if (onImageRegion && ready && arrow && plain) {
            event.preventDefault()
            event.stopPropagation()
            const [dx, dy] = arrow
            const stepX = KEY_STEP / (image.width * scale)
            const stepY = KEY_STEP / (image.height * scale)
            const center = visibleRegion
              ? {
                  x: visibleRegion.x + visibleRegion.width / 2,
                  y: visibleRegion.y + visibleRegion.height / 2
                }
              : { x: 0.5, y: 0.5 }
            const from = marker ?? { ...center, width: 0, height: 0 }
            setMarker(
              event.shiftKey
                ? {
                    ...from,
                    width: clamp(from.width + dx * stepX),
                    height: clamp(from.height + dy * stepY)
                  }
                : { ...from, x: clamp(from.x + dx * stepX), y: clamp(from.y + dy * stepY) }
            )
            return
          }
          if (marker && event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            const region = markerRegion(marker)
            if (region.width && region.height) onImageRegion?.(region)
            else onImagePoint?.(marker.x, marker.y)
            setMarker(null)
            return
          }
          if ((marker || select.current) && event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancelSelection()
            onSelectionCancel?.()
            return
          }
          if (!['+', '=', '-', ...(digitZoom ? ['0', '1'] : [])].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === '0') zoomTo(null)
          else if (event.key === '1') zoomTo(1)
          else zoomTo((zoom) => zoom * (event.key === '-' ? 1 / 1.25 : 1.25))
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return
          // Another pointer owns the drag in progress.
          if (drag.current && drag.current.id !== event.pointerId) return
          moved.current = false
          event.currentTarget.focus()
          const presented = interruptZoom()
          if (presented) updateView(constrain(presented))
          const start = onImageRegion && imagePoint(event.clientX, event.clientY)
          if (!ready || (!start && ((presented ?? latestView.current).zoom ?? fit) <= fit)) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
          if (start) {
            select.current = { x: clamp(start.x), y: clamp(start.y) }
            setMarker(null)
          } else setDragging(true)
        }}
        onPointerMove={(event) => {
          const previous = drag.current
          if (!previous || previous.id !== event.pointerId) return
          if (
            !moved.current &&
            Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 3
          )
            return
          moved.current = true
          const start = select.current
          if (start) {
            const end = imagePoint(event.clientX, event.clientY)
            if (!end) return
            const [x, y] = [clamp(end.x), clamp(end.y)]
            const region = {
              x: Math.min(start.x, x),
              y: Math.min(start.y, y),
              width: Math.abs(x - start.x),
              height: Math.abs(y - start.y)
            }
            start.region = region
            setBand(region)
            return
          }
          pan(event.clientX - previous.x, event.clientY - previous.y)
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
        }}
        onPointerUp={(event) => {
          // Only the pointer that started the drag ends it.
          if (drag.current && drag.current.id !== event.pointerId) return
          // Report before the capture ends, which clears the drag.
          const region = select.current?.region
          if (region?.width && region.height) onImageRegion?.(region)
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          stopDragging()
        }}
        onPointerCancel={(event) => {
          if (drag.current && drag.current.id !== event.pointerId) return
          moved.current = true
          stopDragging()
        }}
        onLostPointerCapture={(event) => {
          if (drag.current && drag.current.id !== event.pointerId) return
          stopDragging()
        }}
      >
        <div
          ref={mediaRef}
          data-zoom-animated={animateZoom.current}
          className="preview-image pointer-events-none absolute left-1/2 top-1/2"
          style={{
            width: ready ? image.width : '100%',
            height: ready ? image.height : '100%',
            translate: '-50% -50%',
            transform: `translate(${current.x}px, ${current.y}px) scale(${scale})`
          }}
        >
          {content}
          {tile && visibleRegion && <PreviewTile tile={tile} />}
          {cache && visibleRegion && <CacheLayer cache={cache} onMiss={onCacheMiss} />}
          {/* In image pixels, inside the image transform. The line widths divide by the
              scale, so the outline stays thin at all zoom levels. */}
          {ready && box && (
            <svg
              data-region-outline
              aria-hidden="true"
              className="absolute inset-0 h-full w-full overflow-visible"
              viewBox={`0 0 ${image.width} ${image.height}`}
            >
              <rect {...box} stroke="rgba(0,0,0,0.5)" strokeWidth={3 / scale} />
              <rect
                {...box}
                stroke="white"
                strokeWidth={1 / scale}
                strokeDasharray={`${4 / scale} ${3 / scale}`}
              />
            </svg>
          )}
        </div>
      </div>
    </div>
  )
}

/** Keep the last decoded tile on screen until its replacement is ready. */
function PreviewTile({ tile }: { tile: Tile }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const controller = new AbortController()
    void loadFrame(tile.url, controller.signal)
      .then((frame) => {
        try {
          const element = canvas.current
          const context = element?.getContext('2d')
          if (controller.signal.aborted || !element || !context) return
          element.width = frame.width
          element.height = frame.height
          context.drawImage(frame.image, 0, 0)
          Object.assign(element.style, {
            left: `${tile.region.x * 100}%`,
            top: `${tile.region.y * 100}%`,
            width: `${tile.region.width * 100}%`,
            height: `${tile.region.height * 100}%`
          })
          element.dataset.previewUrl = tile.url
        } finally {
          frame.release()
        }
      })
      .catch(() => {
        // Retain previously drawn pixels if a replacement was cancelled.
      })
    return () => controller.abort()
  }, [tile])
  return <canvas ref={canvas} data-editor-tile aria-hidden="true" className="absolute" />
}

/**
 * Paint cached native renders into one canvas of the native image size. They
 * all use one recipe, so where they overlap their pixels agree and the paint
 * order does not matter.
 */
function CacheLayer({
  cache,
  onMiss
}: {
  cache: PreviewCache
  onMiss?: (url: string) => void
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const painted = useRef({ key: '', urls: new Set<string>() })
  const loading = useRef(new Set<AbortController>())
  const queue = useRef<CacheLoad[]>([])
  // Few loads at a time bound the pixels in flight; the rest wait in order.
  const pump = useCallback(function next(): void {
    while (loading.current.size < CACHE_LOADS && queue.current.length) {
      const { url, x, y, onMiss } = queue.current.shift()!
      const key = painted.current.key
      const load = new AbortController()
      loading.current.add(load)
      void loadFrame(url, load.signal)
        .then((frame) => {
          try {
            if (painted.current.key !== key) return
            canvas.current?.getContext('2d')?.drawImage(frame.image, x, y)
          } finally {
            frame.release()
          }
        })
        .catch(() => {
          if (painted.current.key !== key) return
          // A later render can bring the same URL back.
          painted.current.urls.delete(url)
          onMiss?.(url)
        })
        .finally(() => {
          loading.current.delete(load)
          next()
        })
    }
  }, [])
  useLayoutEffect(() => {
    const element = canvas.current!
    if (painted.current.key !== cache.key) {
      loading.current.forEach((load) => load.abort())
      loading.current.clear()
      queue.current = []
      // Setting the size also clears the canvas.
      element.width = cache.width
      element.height = cache.height
      painted.current = { key: cache.key, urls: new Set() }
    }
    for (const { url, region } of cache.renders) {
      if (painted.current.urls.has(url)) continue
      painted.current.urls.add(url)
      const x = Math.round(region.x * cache.width)
      const y = Math.round(region.y * cache.height)
      queue.current.push({ url, x, y, onMiss })
    }
    pump()
  }, [cache, onMiss, pump])
  useEffect(() => {
    const loads = loading.current
    const element = canvas.current
    return () => {
      queue.current = []
      loads.forEach((load) => load.abort())
      loads.clear()
      // Give the large backing store back now, not at garbage collection. A
      // remount (React StrictMode) paints again from the start.
      if (element) element.width = element.height = 0
      painted.current = { key: '', urls: new Set() }
    }
  }, [])
  return (
    <canvas
      ref={canvas}
      data-editor-cache
      aria-hidden="true"
      className="absolute inset-0 h-full w-full"
    />
  )
}
