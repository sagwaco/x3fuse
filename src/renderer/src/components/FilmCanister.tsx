import { useId } from 'react'

/** A rounded square sheet of film, labeled with `text` in `ink` on `color`. */
export function FilmCanister({
  color,
  ink,
  text,
  className
}: {
  color: string
  ink: string
  text: string
  className?: string
}): React.JSX.Element {
  const shade = `sheet-shade-${useId().replace(/:/g, '')}`
  return (
    <svg viewBox="0 0 44 44" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={shade}>
          <stop offset="0" stopColor="#000" stopOpacity="0.35" />
          <stop offset="0.3" stopColor="#fff" stopOpacity="0.25" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.4" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="42"
        height="42"
        rx="6"
        fill={color}
        stroke="#000"
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
      <text
        x="22"
        y="22"
        textAnchor="middle"
        dominantBaseline="central"
        fill={ink}
        // 13.2 units is 12 px at the 40 px size. Bold system glyphs are about 0.62 em wide.
        fontSize={Math.min(13.2, 28 / (0.62 * text.length))}
        fontWeight="800"
        fontFamily="inherit"
      >
        {text}
      </text>
      <rect x="1" y="1" width="42" height="42" rx="6" fill={`url(#${shade})`} />
    </svg>
  )
}
