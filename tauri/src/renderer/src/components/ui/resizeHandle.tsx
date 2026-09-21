import { useEffect, useRef } from 'react'
import { cn } from '../../lib/cn'

/** Shared pointer/keyboard behavior for column edges and right-hand panel dividers. */
export function ResizeHandle({
  label,
  hint,
  value,
  min,
  max,
  direction = 1,
  onChange,
  onCommit,
  onCancel,
  onReset,
  className
}: {
  label: string
  hint: string
  value: number
  min: number
  max: number
  direction?: 1 | -1
  onChange: (width: number) => void
  onCommit: (width: number) => void
  onCancel: () => void
  onReset: () => void
  className?: string
}): React.JSX.Element {
  const drag = useRef<{ x: number; start: number; width: number } | null>(null)
  const clamp = (width: number): number => Math.round(Math.max(min, Math.min(max, width)))

  function stopDrag() {
    const current = drag.current
    if (current) {
      drag.current = null
      document.documentElement.classList.remove('resizing-columns')
    }
    return current
  }

  useEffect(
    () => () => {
      if (drag.current) document.documentElement.classList.remove('resizing-columns')
    },
    []
  )

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      title={hint}
      className={cn(
        'absolute z-20 w-2 touch-none cursor-col-resize focus-visible:bg-blue-400/30 focus-visible:outline-none',
        className
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, start: value, width: value }
        document.documentElement.classList.add('resizing-columns')
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        drag.current.width = clamp(
          drag.current.start + direction * (event.clientX - drag.current.x)
        )
        onChange(drag.current.width)
      }}
      onPointerUp={(event) => {
        const current = stopDrag()
        if (!current) return
        const { width, start } = current
        event.currentTarget.releasePointerCapture(event.pointerId)
        if (width !== start) onCommit(width)
        else onCancel()
      }}
      onLostPointerCapture={() => {
        if (stopDrag()) onCancel()
      }}
      onPointerCancel={() => {
        if (stopDrag()) onCancel()
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onReset()
      }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Enter') return onReset()
        const width =
          event.key === 'Home'
            ? min
            : event.key === 'End'
              ? max
              : clamp(
                  value +
                    (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 50 : 10)
                )
        onChange(width)
        onCommit(width)
      }}
    />
  )
}
