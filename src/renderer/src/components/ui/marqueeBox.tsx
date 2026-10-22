import type { Box } from '../../hooks/useMarquee'

/** The drag rectangle, drawn in the scroll content. */
export function MarqueeBox({ box }: { box: Box | null }): React.JSX.Element | null {
  if (!box) return null
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-20 rounded-sm border border-yellow-400/70 bg-yellow-400/15"
      style={{
        left: box.left,
        top: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top
      }}
    />
  )
}
