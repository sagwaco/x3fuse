import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditRecipe, RenderedPreview } from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { t } from '../lib/strings'
import { ipc } from '../lib/ipc'
import { pictureQuad } from '../lib/perspective'
import {
  FULL,
  SNAP,
  cropToFrame,
  dragFrame,
  fitCrop,
  fitDrag,
  frameToCrop,
  sweptAngle,
  type Frame,
  type Rect
} from '../lib/cropGeometry'

/** Grab distance and handle size, in screen pixels. */
const GRAB = 14
const HANDLE = 18
/** The rotate zone reaches this far outside the frame, in screen pixels. */
const ROTATE = 48
/** Padding around the picture, as a fraction of its long side, for the rotate zone. */
const PADDING = 0.08
const arrow = (stroke: string, width: number): string =>
  `<path d='M19 12a7 7 0 1 1-2.1-5M19 4v4h-4' fill='none' stroke='${stroke}' stroke-width='${width}' stroke-linecap='round' stroke-linejoin='round'/>`
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>${arrow('black', 4)}${arrow('white', 2)}</svg>`
)}") 12 12, alias`
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
  new: 'crosshair',
  rotate: ROTATE_CURSOR
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
  onDone,
  onPaint
}: {
  preview: RenderedPreview
  recipe: EditRecipe
  /** Keep the frame's current aspect ratio while resizing. */
  locked: boolean
  onDone: () => void
  /** Called after the image loads. */
  onPaint?: () => void
}): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const svg = useRef<SVGSVGElement>(null)
  const layer = useRef<SVGGElement>(null)
  const drag = useRef<{
    x: number
    y: number
    frame: Frame
    handle: string
    fresh: boolean
    /** Rotate drags: the angle, crop and pivot at the start, and the last snapped angle. */
    turn?: { angle: number; crop: Rect; center: { x: number; y: number }; last: number }
  }>()
  const [hover, setHover] = useState('new')
  // Painting an image that is not decoded decodes it on the main thread, which
  // stops animations such as the fade of the developing cloud. Decode each
  // image first, and show the last one until then.
  const [shown, setShown] = useState<string>()
  useEffect(() => {
    let live = true
    const show = (): void => {
      if (live) setShown(preview.url)
    }
    const image = new Image()
    image.src = preview.url
    image.decode().then(show, show)
    return () => {
      live = false
    }
  }, [preview.url])
  const [scale, setScale] = useState(1)
  // Keep drag coordinates in the same units when a refined preview arrives.
  const [{ width: W, height: H }] = useState(preview)
  const angle = recipe.straighten
  const rotation = recipe.rotation % 4
  const frame = cropToFrame(recipe.crop ?? FULL, angle, W, H)
  const ratio = locked ? frame.width / frame.height : undefined
  const smallest = Math.min(W, H) * 0.03
  const pad = Math.max(W, H) * PADDING
  const { pitch, yaw } = recipe
  // Outside the picture outline a perspective correction leaves the image empty.
  const quad = useMemo(
    () => (pitch || yaw ? pictureQuad(pitch, yaw, W, H) : undefined),
    [pitch, yaw, W, H]
  )
  const [viewWidth, viewHeight] = rotation % 2 ? [H, W] : [W, H]
  const turn = [
    '',
    `translate(${H} 0) rotate(90)`,
    `translate(${W} ${H}) rotate(180)`,
    `translate(0 ${W}) rotate(270)`
  ][rotation]

  // Take focus from the toolbar button that opened crop mode, so Return, Escape and
  // the arrow keys reach the frame instead of the photo strip.
  useEffect(() => svg.current?.focus({ preventScroll: true }), [])
  useEffect(() => {
    const element = svg.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) =>
      setScale(
        Math.min(
          entry.contentRect.width / (viewWidth + 2 * pad),
          entry.contentRect.height / (viewHeight + 2 * pad)
        ) || 1
      )
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [viewWidth, viewHeight, pad])

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
    const outside = Math.hypot(
      Math.max(frame.x - p.x, 0, p.x - right),
      Math.max(frame.y - p.y, 0, p.y - bottom)
    )
    if (outside > 0 && outside <= ROTATE / scale) return 'rotate'
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
          ? frameToCrop(next, angle, W, H, quad)
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
            H,
            quad
          )
        : null
    if (crop) change({ crop })
  }
  /** Turn the picture by the angle the pointer swept around the frame center. */
  const rotate = (p: { x: number; y: number }, snap: boolean): void => {
    const start = drag.current
    if (!start?.turn) return
    const { turn } = start
    const value = sweptAngle(turn.angle, start, p, turn.center, snap)
    // macOS plays this on Force Touch trackpads; elsewhere it's a no-op.
    if (snap && value !== turn.last) ipc.invoke('haptics:detent').catch(() => {})
    turn.last = snap ? value : Math.round(value / SNAP) * SNAP
    const crop = fitCrop(turn.crop, value, pitch, yaw, W, H)
    change(crop === turn.crop ? { straighten: value } : { straighten: value, crop }, false)
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
      viewBox={`${-pad} ${-pad} ${viewWidth + 2 * pad} ${viewHeight + 2 * pad}`}
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
        if (handle === 'rotate')
          drag.current.turn = {
            angle,
            crop: recipe.crop ?? FULL,
            center: { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 },
            last: Math.round(angle / SNAP) * SNAP
          }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const p = point(event)
        if (!p) return
        const start = drag.current
        if (!start) return setHover(handleAt(p))
        if (start.handle === 'rotate') return rotate(p, event.shiftKey)
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
        <g transform={angle ? `rotate(${angle} ${W / 2} ${H / 2})` : undefined}>
          {shown && <image href={shown} width={W} height={H} onLoad={onPaint} />}
          {quad && (
            <polygon
              {...line}
              opacity={0.35}
              strokeDasharray="4 4"
              points={quad.map((q) => `${q.x},${q.y}`).join(' ')}
            />
          )}
        </g>
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
