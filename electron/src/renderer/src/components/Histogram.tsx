import { useHistogram, type HistogramData } from '../hooks/useHistogram'
import { t } from '../lib/strings'

const CHANNELS: { key: keyof HistogramData; label: string; color: string }[] = [
  { key: 'r', label: 'R', color: '#ef4444' },
  { key: 'g', label: 'G', color: '#22c55e' },
  { key: 'b', label: 'B', color: '#3b82f6' }
]

const VIEW_W = 255
const VIEW_H = 100

/** Three stacked RGB histograms for the inspector, computed from the preview JPEG. */
export function Histogram({
  url,
  aspectRatio
}: {
  url: string | undefined
  aspectRatio?: number
}): React.JSX.Element {
  const data = useHistogram(url, aspectRatio)

  if (data === 'loading') {
    return (
      <div className="space-y-2">
        {CHANNELS.map((c) => (
          <div key={c.key} className="h-12 animate-pulse rounded bg-neutral-800/50" />
        ))}
      </div>
    )
  }

  if (!data) {
    return <p className="py-4 text-center text-xs text-neutral-600">{t('inspector.no_preview')}</p>
  }

  return (
    <div className="space-y-2">
      {CHANNELS.map((c) => (
        <ChannelChart key={c.key} bins={data[c.key]} label={c.label} color={c.color} />
      ))}
    </div>
  )
}

function ChannelChart({
  bins,
  label,
  color
}: {
  bins: number[]
  label: string
  color: string
}): React.JSX.Element {
  // Scale to the tallest bin, ignoring the pure-black/white spikes (0 and 255)
  // that otherwise flatten the curve.
  const max = Math.max(1, ...bins.slice(1, 255))

  return (
    <div className="relative h-12 overflow-hidden rounded bg-neutral-950/60">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="h-full w-full"
      >
        <path d={buildPath(bins, max)} fill={color} fillOpacity={0.35} stroke={color} strokeWidth={0.75} />
      </svg>
      <span className="absolute left-1 top-0.5 text-[10px] font-medium text-neutral-500">
        {label}
      </span>
    </div>
  )
}

function buildPath(bins: number[], max: number): string {
  let d = `M0,${VIEW_H}`
  for (let i = 0; i < 256; i++) {
    const y = VIEW_H - Math.min(VIEW_H, (bins[i] / max) * VIEW_H)
    d += ` L${i},${y.toFixed(2)}`
  }
  d += ` L255,${VIEW_H} Z`
  return d
}
