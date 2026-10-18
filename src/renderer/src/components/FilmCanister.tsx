import { useId } from 'react'

const SPROCKETS = [4, 8, 12, 16]
  .flatMap((x) => [`M${x} 14h2v2.5h-2z`, `M${x} 34h2v2.5h-2z`])
  .join('')

/** A 35 mm film canister with its leader out, labeled with `text` in `ink` on `color`. */
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
  const shade = `canister-shade-${useId().replace(/:/g, '')}`
  return (
    <svg viewBox="0 0 44 48" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={shade}>
          <stop offset="0" stopColor="#000" stopOpacity="0.35" />
          <stop offset="0.3" stopColor="#fff" stopOpacity="0.25" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.4" />
        </linearGradient>
      </defs>
      {/* The leader. Its sprocket holes show what is behind the canister. */}
      <path
        fillRule="evenodd"
        fill="#4a2412"
        d={`M22 12H7C3.5 12 1 14.5 1 18V38H22Z${SPROCKETS}`}
      />
      <rect x="24" y="1" width="10" height="5" rx="1" fill="#141414" />
      <rect x="17" y="5" width="24" height="4" rx="1" fill="#1e1e1e" />
      <rect x="17" y="41" width="24" height="4" rx="1" fill="#1e1e1e" />
      <rect x="18" y="8.5" width="22" height="33" fill={color} />
      <rect x="20.5" y="8.5" width="4" height="33" fill={ink} />
      <text
        x="32.5"
        y="25"
        transform="rotate(90 32.5 25)"
        textAnchor="middle"
        dominantBaseline="central"
        fill={ink}
        fontSize={Math.min(12, 28 / (0.62 * text.length))}
        fontWeight="800"
        fontFamily="inherit"
      >
        {text}
      </text>
      {/* The felt light trap, where the film comes out. */}
      <rect x="17.5" y="8.5" width="2" height="33" fill="#262626" />
      <rect x="24" y="1" width="10" height="5" fill={`url(#${shade})`} />
      <rect x="17" y="5" width="24" height="40" fill={`url(#${shade})`} />
    </svg>
  )
}
