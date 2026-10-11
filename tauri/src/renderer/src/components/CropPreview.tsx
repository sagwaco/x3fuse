import { useEffect, useRef, useState } from 'react'
import type { EditRecipe, RenderedPreview } from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { t } from '../lib/strings'
import {
  FULL,
  cropToFrame,
  dragFrame,
  fitDrag,
  frameToCrop,
  type Frame,
  type Rect
} from '../lib/cropGeometry'

/** Grab distance and handle size, in screen pixels. */
const GRAB = 14
const HANDLE = 18
const CURSORS: Record<string, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  move: 'move',
  new: 'crosshair'
}
/** Screen arrow direction in frame space, per quarter turn. */
const TURNS = [
  [1, 0, 0, 1],
  [0, 1, -1, 0],
  [-1, 0, 0, -1],
  [0, -1, 1, 0]
]

/**
 * Crop on the uncropped preview. The picture turns under an upright frame as
 * you straighten, and quarter turns rotate the whole view.
 */
export function CropPreview({
  preview,
  recipe,
  locked,
  onDone
}: {
  preview: RenderedPreview
  recipe: EditRecipe
  /** Keep the frame's current aspect ratio while resizing. */
  locked: boolean
  onDone: () => void
}): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const svg = useRef<SVGSVGElement>(null)
  const layer = useRef<SVGGElement>(null)
  const drag = useRef<{ x: number; y: number; frame: Frame; handle: string; fresh: boolean }>()
  const [hover, setHover] = useState('new')
  const [scale, setScale] = useState(1)
  const { width: W, height: H } = preview
  const angle = recipe.straighten
  const rotation = recipe.rotation % 4
  const frame = cropToFrame(recipe.crop ?? FULL, angle, W, H)
  const ratio = locked ? frame.width / frame.height : undefined
  const smallest = Math.min(W, H) * 0.03
  const [viewWidth, viewHeight] = rotation % 2 ? [H, W] : [W, H]
  const turn = [
    '',
    `translate(${H} 0) rotate(90)`,
    `translate(${W} ${H}) rotate(180)`,
    `translate(0 ${W}) rotate(270)`
  ][rotation]

  useEffect(() => {
    const element = svg.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) =>
      setScale(
        Math.min(entry.contentRect.width / viewWidth, entry.contentRect.height / viewHeight) || 1
      )
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [viewWidth, viewHeight])

  const point = (event: React.PointerEvent): { x: number; y: number } | null => {
    const matrix = layer.current?.getScreenCTM()
    if (!matrix) return null
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return { x: p.x, y: p.y }
  }
  const handleAt = (p: { x: number; y: number }): string => {
    const grab = GRAB / scale
    const right = frame.x + frame.width
    const bottom = frame.y + frame.height
    const alongX = p.x > frame.x - grab && p.x < right + grab
    const alongY = p.y > frame.y - grab && p.y < bottom + grab
    const v = !alongX
      ? ''
      : Math.abs(p.y - frame.y) < grab
        ? 'n'
        : Math.abs(p.y - bottom) < grab
          ? 's'
          : ''
    const h = !alongY
      ? ''
      : Math.abs(p.x - frame.x) < grab
        ? 'w'
        : Math.abs(p.x - right) < grab
          ? 'e'
          : ''
    if (v || h) return v + h
    // A frame filling the picture can't move; dragging inside draws a new crop.
    const whole = !recipe.crop || (recipe.crop.width > 0.999 && recipe.crop.height > 0.999)
    const inside = p.x > frame.x && p.x < right && p.y > frame.y && p.y < bottom
    return inside && !whole ? 'move' : 'new'
  }
  /** Apply as much of a drag as keeps the crop inside the picture. */
  const apply = (
    start: Frame,
    handle: string,
    dx: number,
    dy: number,
    save: boolean,
    fresh = false
  ): void => {
    const crop = fitDrag(
      (x, y) => {
        const next = dragFrame(start, handle, x, y, ratio)
        return fresh || (next.width >= smallest && next.height >= smallest)
          ? frameToCrop(next, angle, W, H)
          : null
      },
      dx,
      dy
    )
    if (crop && (!fresh || (crop.width * W >= smallest && crop.height * H >= smallest)))
      change({ crop }, save)
  }
  const scaleFrame = (factor: number): void => {
    const width = frame.width * factor
    const height = frame.height * factor
    const crop: Rect | null =
      width >= smallest && height >= smallest
        ? frameToCrop(
            {
              x: frame.x + (frame.width - width) / 2,
              y: frame.y + (frame.height - height) / 2,
              width,
              height
            },
            angle,
            W,
            H
          )
        : null
    if (crop) change({ crop })
  }
  const end = (): void => {
    if (!drag.current) return
    drag.current = undefined
    commit()
  }
  const line = { vectorEffect: 'non-scaling-stroke', stroke: 'white', fill: 'none' } as const
  const { x, y, width, height } = frame
  const r = x + width
  const b = y + height
  const L = HANDLE / scale
  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      className="h-full w-full touch-none focus-visible:outline-none"
      style={{ cursor: CURSORS[drag.current?.handle ?? hover] }}
      tabIndex={0}
      role="application"
      aria-label={t('editor.cropCanvas')}
      onPointerDown={(event) => {
        const p = event.button === 0 ? point(event) : null
        if (!p) return
        const handle = handleAt(p)
        const fresh = handle === 'new'
        drag.current = fresh
          ? { ...p, frame: { ...p, width: 0, height: 0 }, handle: 'se', fresh }
          : { ...p, frame, handle, fresh }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const p = point(event)
        if (!p) return
        const start = drag.current
        if (!start) return setHover(handleAt(p))
        apply(start.frame, start.handle, p.x - start.x, p.y - start.y, false, start.fresh)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          return onDone()
        }
        if (event.key === '=' || event.key === '+' || event.key === '-') {
          event.preventDefault()
          return scaleFrame(event.key === '-' ? 0.95 : 1 / 0.95)
        }
        const [sx, sy] =
          { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
            event.key
          ] ?? []
        if (sx === undefined) return
        event.preventDefault()
        const [a, c, d, e] = TURNS[rotation]
        const step = Math.min(W, H) * (event.shiftKey ? 0.1 : 0.01)
        apply(frame, 'move', (a * sx + c * sy) * step, (d * sx + e * sy) * step, true)
      }}
    >
      <g ref={layer} transform={turn}>
        <image
          href={preview.url}
          width={W}
          height={H}
          transform={angle ? `rotate(${angle} ${W / 2} ${H / 2})` : undefined}
        />
        <path
          fill="black"
          opacity="0.6"
          fillRule="evenodd"
          d={`M${-W} ${-H}H${2 * W}V${2 * H}H${-W}Z M${x} ${y}H${r}V${b}H${x}Z`}
        />
        {/* Thirds for composing; a finer grid while straightening. */}
        {(angle ? [1, 2, 3, 4, 5].map((i) => i / 6) : [1 / 3, 2 / 3]).map((f) => (
          <path
            key={f}
            {...line}
            opacity={angle && f !== 1 / 3 && f !== 2 / 3 ? 0.18 : 0.4}
            d={`M${x + width * f} ${y}V${b} M${x} ${y + height * f}H${r}`}
          />
        ))}
        <rect {...line} x={x} y={y} width={width} height={height} strokeWidth={1} />
        <path
          {...line}
          strokeWidth={3}
          d={[
            `M${x} ${y + L}V${y}H${x + L}`,
            `M${r - L} ${y}H${r}V${y + L}`,
            `M${r} ${b - L}V${b}H${r - L}`,
            `M${x + L} ${b}H${x}V${b - L}`,
            `M${x + width / 2 - L / 2} ${y}h${L} M${x + width / 2 - L / 2} ${b}h${L}`,
            `M${x} ${y + height / 2 - L / 2}v${L} M${r} ${y + height / 2 - L / 2}v${L}`
          ].join(' ')}
        />
      </g>
    </svg>
  )
}
