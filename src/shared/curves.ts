import type { CurvePoint } from './editor'

function slopes(points: CurvePoint[]): number[] {
  const segments = points.slice(1).map((point, i) => {
    const width = point.x - points[i].x
    return { width, slope: (point.y - points[i].y) / width }
  })
  const result = [segments[0].slope, ...segments.map((segment) => segment.slope)]
  if (points.length === 2) return result

  const endpoint = (a: (typeof segments)[number], b: (typeof segments)[number]): number => {
    const slope = ((2 * a.width + b.width) * a.slope - a.width * b.slope) / (a.width + b.width)
    return slope * a.slope <= 0
      ? 0
      : Math.sign(slope) * Math.min(Math.abs(slope), 3 * Math.abs(a.slope))
  }
  result[0] = endpoint(segments[0], segments[1])
  result[result.length - 1] = endpoint(segments.at(-1)!, segments.at(-2)!)
  for (let i = 1; i < points.length - 1; i++) {
    const a = segments[i - 1]
    const b = segments[i]
    const w1 = 2 * b.width + a.width
    const w2 = b.width + 2 * a.width
    // The weighted harmonic mean prevents overshoot between unequal intervals.
    result[i] = a.slope * b.slope <= 0 ? 0 : (w1 + w2) / (w1 / a.slope + w2 / b.slope)
  }
  return result
}

export function evaluateCurve(points: CurvePoint[], x: number): number {
  const tangents = slopes(points)
  const next = points.findIndex((point) => point.x >= x)
  const i = Math.max(1, next === -1 ? points.length - 1 : next)
  const a = points[i - 1]
  const b = points[i]
  const width = b.x - a.x
  const t = Math.max(0, Math.min(1, (x - a.x) / width))
  const u = 1 - t
  const c1 = a.y + (width * tangents[i - 1]) / 3
  const c2 = b.y - (width * tangents[i]) / 3
  return Math.max(
    Math.min(a.y, b.y),
    Math.min(
      Math.max(a.y, b.y),
      u ** 3 * a.y + 3 * u ** 2 * t * c1 + 3 * u * t ** 2 * c2 + t ** 3 * b.y
    )
  )
}

export function curvePath(points: CurvePoint[]): string {
  const tangents = slopes(points)
  let path = `M ${points[0].x * 200} ${(1 - points[0].y) * 200}`
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const third = (b.x - a.x) / 3
    path += ` C ${(a.x + third) * 200} ${(1 - a.y - third * tangents[i - 1]) * 200} ${(b.x - third) * 200} ${(1 - b.y + third * tangents[i]) * 200} ${b.x * 200} ${(1 - b.y) * 200}`
  }
  return path
}

/**
 * The curve input that gives an output value: the point of the curve that changes a pixel
 * of that value. Of equal matches, the input nearest the value wins.
 */
export function curveInput(points: CurvePoint[], value: number): number {
  let best = value
  let error = Infinity
  for (let i = 0; i <= 1000; i++) {
    const x = i / 1000
    const e = Math.abs(evaluateCurve(points, x) - value) + Math.abs(x - value) * 1e-3
    if (e < error) [best, error] = [x, e]
  }
  return best
}
