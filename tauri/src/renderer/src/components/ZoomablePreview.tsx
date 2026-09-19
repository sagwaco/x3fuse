import { useCallback, useEffect, useRef, useState } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { t } from '../lib/strings'
import { OrientedImage } from './OrientedImage'
import { usePreviewStore } from '../stores/previewStore'

type View = { zoom: number | null; x: number; y: number }
type ZoomOptions = { x?: number; y?: number; animate?: boolean; center?: boolean }
const FIT: View = { zoom: null, x: 0, y: 0 }
const MAX_ZOOM = 8

/** Zoom is relative to the oriented JPEG's natural dimensions; null follows Fit. */
export function ZoomablePreview({ file }: { file: X3FFileDTO }): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLDivElement>(null)
  const animateZoom = useRef(false)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const moved = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [image, setImage] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<View>(FIT)
  const ready = image.width > 0 && image.height > 0 && size.width > 0 && size.height > 0
  const fit = ready ? Math.min(1, size.width / image.width, size.height / image.height) : 1
  const minZoom = Math.min(0.1, fit)

  useEffect(() => {
    const viewport = viewportRef.current!
    const observer = new ResizeObserver(([entry]) => {
      animateZoom.current = false
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const constrain = useCallback(
    (next: View): View => {
      const scale = next.zoom ?? fit
      const maxX = Math.max(0, (image.width * scale - size.width) / 2)
      const maxY = Math.max(0, (image.height * scale - size.height) / 2)
      return {
        ...next,
        x: Math.max(-maxX, Math.min(maxX, next.x)),
        y: Math.max(-maxY, Math.min(maxY, next.y))
      }
    },
    [fit, image, size]
  )

  // Clamp stored offsets too, so resizing away an edge cannot resurrect an old pan.
  useEffect(() => setView(constrain), [constrain])

  // Read the presentation once when a gesture interrupts an eased zoom. All
  // animation frames stay in the compositor, without React/store updates.
  const interruptZoom = useCallback((): View | null => {
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
      setView((previous) => {
        const current = constrain(presented ?? previous)
        const oldScale = current.zoom ?? fit
        const requested = typeof target === 'function' ? target(oldScale) : target
        if (requested === null) return FIT
        const zoom = Math.max(minZoom, Math.min(MAX_ZOOM, requested))
        const ratio = zoom / oldScale
        return constrain({
          zoom,
          x: (center ? 0 : x) - (x - current.x) * ratio,
          y: (center ? 0 : y) - (y - current.y) * ratio
        })
      })
    },
    [ready, constrain, fit, minZoom, interruptZoom]
  )

  const pan = useCallback(
    (x: number, y: number): void => {
      const presented = interruptZoom()
      setView((previous) => {
        const current = constrain(presented ?? previous)
        return constrain({ ...current, x: current.x + x, y: current.y + y })
      })
    },
    [constrain, interruptZoom]
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
      setView((previous) => {
        const current = constrain(presented ?? previous)
        const scale = current.zoom ?? fit
        return constrain({
          ...current,
          x: (0.5 - centerX) * image.width * scale,
          y: (0.5 - centerY) * image.height * scale
        })
      })
    },
    [constrain, image, fit, interruptZoom]
  )

  useEffect(() => {
    const width = Math.min(1, size.width / (image.width * scale))
    const height = Math.min(1, size.height / (image.height * scale))
    usePreviewStore.setState({
      minimap: canPan
        ? {
            fileId: file.id,
            aspectRatio: image.width / image.height,
            x: 0.5 - current.x / (image.width * scale) - width / 2,
            y: 0.5 - current.y / (image.height * scale) - height / 2,
            width,
            height,
            panTo
          }
        : null
    })
  }, [canPan, file.id, image, size, scale, current.x, current.y, panTo])

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

  useEffect(
    () => () => {
      const { minimap, controls } = usePreviewStore.getState()
      if (minimap?.fileId === file.id || controls?.fileId === file.id) {
        usePreviewStore.setState({ minimap: null, controls: null })
      }
    },
    [file.id]
  )

  const stopDragging = (): void => {
    drag.current = null
    setDragging(false)
  }

  return (
    <div className="relative h-full w-full min-h-0 min-w-0">
      <div
        ref={viewportRef}
        role="region"
        aria-label={t('preview.image')}
        tabIndex={0}
        className="absolute inset-0 overflow-hidden overscroll-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60"
        style={{
          cursor: dragging ? 'grabbing' : canPan ? 'grab' : ready ? 'zoom-in' : 'default',
          touchAction: 'none'
        }}
        onClick={(event) => {
          if (!moved.current) {
            const rect = event.currentTarget.getBoundingClientRect()
            zoomTo(scale === fit && fit < 1 ? 1 : null, {
              x: event.detail ? event.clientX - rect.left - rect.width / 2 : 0,
              y: event.detail ? event.clientY - rect.top - rect.height / 2 : 0,
              center: true
            })
          }
          moved.current = false
        }}
        onKeyDown={(event) => {
          if (!['+', '=', '-', '0', '1'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === '0') zoomTo(null)
          else if (event.key === '1') zoomTo(1)
          else zoomTo((zoom) => zoom * (event.key === '-' ? 1 / 1.25 : 1.25))
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return
          moved.current = false
          event.currentTarget.focus()
          const presented = interruptZoom()
          if (presented) setView(constrain(presented))
          if (!(presented ? (presented.zoom ?? fit) > fit : canPan)) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
          setDragging(true)
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
          pan(event.clientX - previous.x, event.clientY - previous.y)
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          stopDragging()
        }}
        onPointerCancel={() => {
          moved.current = true
          stopDragging()
        }}
        onLostPointerCapture={stopDragging}
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
          <OrientedImage
            file={file}
            variant="full"
            loading="eager"
            containerClassName="h-full w-full"
            className="h-full w-full object-contain"
            onLoad={(image) =>
              setImage({
                width: image.naturalWidth,
                height: image.naturalHeight
              })
            }
          />
        </div>
      </div>
    </div>
  )
}
