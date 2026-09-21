import { useRef } from 'react'
import type { EditRecipe, RenderedPreview } from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { t } from '../lib/strings'

type Rect = NonNullable<EditRecipe['crop']>
const clamp = (n: number, max = 1): number => Math.max(0, Math.min(max, n))

/** Crop in the EXIF-oriented full-image coordinate space, before rotation. */
export function CropPreview({
  preview,
  recipe
}: {
  preview: RenderedPreview
  recipe: EditRecipe
}): React.JSX.Element {
  const start = useRef<{ x: number; y: number; crop: Rect; handle: string }>()
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const crop = recipe.crop ?? { x: 0, y: 0, width: 1, height: 1 }
  const width = preview.width,
    height = preview.height
  const point = (event: React.PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = Math.min(rect.width / width, rect.height / height)
    return {
      x: clamp((event.clientX - rect.left - (rect.width - width * scale) / 2) / (width * scale)),
      y: clamp((event.clientY - rect.top - (rect.height - height * scale) / 2) / (height * scale))
    }
  }
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-full w-full touch-none"
      role="img"
      aria-label={t('editor.cropCanvas')}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const p = point(event)
        const inside =
          p.x >= crop.x &&
          p.x <= crop.x + crop.width &&
          p.y >= crop.y &&
          p.y <= crop.y + crop.height
        const edge = 0.025
        const horizontal =
          Math.abs(p.x - crop.x) < edge
            ? 'w'
            : Math.abs(p.x - crop.x - crop.width) < edge
              ? 'e'
              : ''
        const vertical =
          Math.abs(p.y - crop.y) < edge
            ? 'n'
            : Math.abs(p.y - crop.y - crop.height) < edge
              ? 's'
              : ''
        start.current = {
          ...p,
          crop,
          handle: inside ? horizontal + vertical || (recipe.crop ? 'move' : 'new') : 'new'
        }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const initial = start.current
        if (!initial) return
        const p = point(event),
          dx = p.x - initial.x,
          dy = p.y - initial.y
        let next = { ...initial.crop }
        if (initial.handle === 'move')
          next = {
            ...next,
            x: clamp(next.x + dx, 1 - next.width),
            y: clamp(next.y + dy, 1 - next.height)
          }
        else if (initial.handle === 'new')
          next = {
            x: Math.min(initial.x, p.x),
            y: Math.min(initial.y, p.y),
            width: Math.abs(dx),
            height: Math.abs(dy)
          }
        else {
          if (initial.handle.includes('w')) {
            next.x = clamp(p.x, initial.crop.x + initial.crop.width - 0.01)
            next.width = initial.crop.x + initial.crop.width - next.x
          }
          if (initial.handle.includes('e')) next.width = Math.max(0.01, p.x - initial.crop.x)
          if (initial.handle.includes('n')) {
            next.y = clamp(p.y, initial.crop.y + initial.crop.height - 0.01)
            next.height = initial.crop.y + initial.crop.height - next.y
          }
          if (initial.handle.includes('s')) next.height = Math.max(0.01, p.y - initial.crop.y)
        }
        if (next.width >= 0.01 && next.height >= 0.01) change({ crop: next }, false)
      }}
      onPointerUp={() => {
        start.current = undefined
        commit()
      }}
      onPointerCancel={() => {
        start.current = undefined
        commit()
      }}
    >
      <image href={preview.url} width={width} height={height} />
      <path
        fill="black"
        opacity="0.55"
        fillRule="evenodd"
        d={`M0 0H${width}V${height}H0Z M${crop.x * width} ${crop.y * height}h${crop.width * width}v${crop.height * height}h${-crop.width * width}Z`}
      />
      <rect
        x={crop.x * width}
        y={crop.y * height}
        width={crop.width * width}
        height={crop.height * height}
        fill="none"
        stroke="white"
        strokeWidth={Math.max(width, height) / 700}
      />
      {[1, 2].map((i) => (
        <path
          key={i}
          d={`M${(crop.x + (crop.width * i) / 3) * width} ${crop.y * height}v${crop.height * height} M${crop.x * width} ${(crop.y + (crop.height * i) / 3) * height}h${crop.width * width}`}
          stroke="white"
          opacity="0.35"
          strokeWidth={Math.max(width, height) / 1000}
        />
      ))}
    </svg>
  )
}
