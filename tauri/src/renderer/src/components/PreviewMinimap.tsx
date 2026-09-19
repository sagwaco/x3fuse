import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { usePreviewStore } from '../stores/previewStore'
import { t } from '../lib/strings'
import { FilmstripImage } from './FilmstripImage'

export function PreviewMinimap({ file }: { file: X3FFileDTO }): React.JSX.Element {
  const map = usePreviewStore((state) => state.minimap)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const latestMap = useRef(map)
  latestMap.current = map
  const pending = useRef<{ fileId: string; x: number; y: number } | null>(null)
  const frame = useRef<number | null>(null)
  const flushPan = useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const point = pending.current
    pending.current = null
    if (point && latestMap.current?.fileId === point.fileId) {
      latestMap.current.panTo(point.x, point.y)
    }
  }, [])

  useEffect(() => {
    setDragging(false)
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      pending.current = null
      drag.current = null
    }
  }, [file.id, map?.fileId])

  // Keep the decoded image subtree out of viewport-overlay updates.
  const image = useMemo(
    () => (
      <FilmstripImage
        file={file}
        containerClassName="absolute inset-0"
        className="h-full w-full object-contain"
      />
    ),
    [file]
  )
  if (!map || map.fileId !== file.id) {
    return (
      <FilmstripImage
        file={file}
        containerClassName="h-44 w-full rounded-md border border-white/10 bg-neutral-900"
      />
    )
  }

  const point = (event: PointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height
    }
  }
  const stopDragging = (): void => {
    flushPan()
    drag.current = null
    setDragging(false)
  }

  return (
    <div className="flex h-44 items-center justify-center rounded-md border border-white/10 bg-neutral-900">
      <div
        className="relative overflow-hidden"
        style={{ width: `min(100%, ${11 * map.aspectRatio}rem)`, aspectRatio: map.aspectRatio }}
      >
        {/* Use the same oriented JPEG as the main image so the window aligns exactly. */}
        {image}
        <div
          role="region"
          aria-label={t('preview.minimap')}
          tabIndex={0}
          className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
          style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return
            event.preventDefault()
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            flushPan()
            const { x, y } = point(event)
            const inside =
              x >= map.x && x <= map.x + map.width && y >= map.y && y <= map.y + map.height
            drag.current = {
              id: event.pointerId,
              x: inside ? x - (map.x + map.width / 2) : 0,
              y: inside ? y - (map.y + map.height / 2) : 0
            }
            setDragging(true)
            map.panTo(x - drag.current.x, y - drag.current.y)
          }}
          onPointerMove={(event) => {
            if (!drag.current || drag.current.id !== event.pointerId) return
            const { x, y } = point(event)
            pending.current = { fileId: file.id, x: x - drag.current.x, y: y - drag.current.y }
            if (frame.current === null) frame.current = requestAnimationFrame(flushPan)
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            stopDragging()
          }}
          onPointerCancel={stopDragging}
          onLostPointerCapture={stopDragging}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
            event.preventDefault()
            const centerX = Math.max(
              map.width / 2,
              Math.min(1 - map.width / 2, pending.current?.x ?? map.x + map.width / 2)
            )
            const centerY = Math.max(
              map.height / 2,
              Math.min(1 - map.height / 2, pending.current?.y ?? map.y + map.height / 2)
            )
            flushPan()
            map.panTo(
              centerX + (event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0),
              centerY + (event.key === 'ArrowUp' ? -0.05 : event.key === 'ArrowDown' ? 0.05 : 0)
            )
          }}
        >
          <div
            className="pointer-events-none absolute border-2 border-blue-400 bg-blue-400/10 shadow-[0_0_0_999px_rgba(0,0,0,0.4)]"
            style={{
              left: `${map.x * 100}%`,
              top: `${map.y * 100}%`,
              width: `${map.width * 100}%`,
              height: `${map.height * 100}%`
            }}
          />
        </div>
      </div>
    </div>
  )
}
