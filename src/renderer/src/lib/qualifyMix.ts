export function qualifyMix(
  matrix: number[],
  sample: [number, number, number],
  output: 0 | 1 | 2
): number[] | null {
  if (
    !Array.isArray(matrix) ||
    matrix.length !== 9 ||
    !matrix.every(Number.isFinite) ||
    !Array.isArray(sample) ||
    sample.length !== 3 ||
    !sample.every((value) => Number.isFinite(value) && value > 0) ||
    (output !== 0 && output !== 1 && output !== 2)
  )
    return null

  const normalized = sample.map((value) => value / Math.max(...sample))
  const mean = normalized.reduce((sum, value) => sum + value, 0) / 3
  const deviation = normalized.map((value) => value - mean)
  const variance = deviation.reduce((sum, value) => sum + value * value, 0)
  if (variance === 0) return null

  const direction = [
    normalized[2] - normalized[1],
    normalized[0] - normalized[2],
    normalized[1] - normalized[0]
  ]
  const length = Math.hypot(...direction)
  if (!Number.isFinite(length) || length === 0) return null
  const unit = direction.map((value) => value / length)
  const squaredLength = unit.reduce((sum, value) => sum + value * value, 0)
  const tolerance = 1e-12
  const result: number[] = []

  for (let row = 0; row < 3; row++) {
    const target = row === output ? 1 : 0
    const center = deviation.map((value) => 1 / 3 + ((target - mean) * value) / variance)
    let lower = -Infinity
    let upper = Infinity
    for (let column = 0; column < 3; column++) {
      if (unit[column] === 0) {
        if (Math.abs(center[column]) > 4 + tolerance) return null
        continue
      }
      const start = (-4 - center[column]) / unit[column]
      const end = (4 - center[column]) / unit[column]
      lower = Math.max(lower, Math.min(start, end))
      upper = Math.min(upper, Math.max(start, end))
    }
    if (lower > upper + tolerance) return null

    const original = matrix.slice(row * 3, row * 3 + 3)
    const scale = Math.max(1, ...original.map(Math.abs))
    // A common row offset has no effect on the projection.
    const projection =
      (unit.reduce(
        (sum, value, column) => sum + value * (original[column] / scale - original[2] / scale),
        0
      ) *
        scale) /
      squaredLength
    const amount =
      lower > upper ? (lower + upper) / 2 : Math.max(lower, Math.min(upper, projection))
    const mixed = center.map((value, column) => value + amount * unit[column])
    if (mixed.some((value) => !Number.isFinite(value) || Math.abs(value) > 4 + tolerance))
      return null

    // Remove only bound roundoff, then check both constraints.
    const bounded = mixed.map((value) => Math.max(-4, Math.min(4, value)))
    const total = bounded.reduce((sum, value) => sum + value, 0)
    const response = bounded.reduce((sum, value, column) => sum + value * normalized[column], 0)
    if (Math.abs(total - 1) > 1e-10 || Math.abs(response - target) > 1e-10) return null
    result.push(...bounded)
  }
  return result
}
