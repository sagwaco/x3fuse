export type LayerMix = [number, number, number]

const SQRT3 = Math.sqrt(3)
const boundaryMixes: LayerMix[] = [
  [-4, 1, 4],
  [1, -4, 4],
  [4, -4, 1],
  [4, 1, -4],
  [1, 4, -4],
  [-4, 4, 1]
]

/** The pad point of a mix: the top layer at the top, middle at the bottom left, bottom at the bottom right. */
export function mixPoint(mix: LayerMix): { x: number; y: number } {
  return { x: ((mix[0] - mix[1]) * SQRT3) / 2, y: mix[2] - (mix[0] + mix[1]) / 2 }
}

export const MIX_BOUNDARY = boundaryMixes.map(mixPoint)

export function pointMix({ x, y }: { x: number; y: number }): LayerMix {
  const top = (1 + 2 * y) / 3
  const middle = (1 - top) / 2 - x / SQRT3
  const mix: LayerMix = [1 - top - middle, middle, top]
  if (mix.every((value) => value >= -4 && value <= 4)) return mix

  // Equal-length reference axes preserve nearest distances on the sum-one plane.
  let nearest = boundaryMixes[0]
  let nearestDistance = Infinity
  for (const [index, start] of boundaryMixes.entries()) {
    const end = boundaryMixes[(index + 1) % boundaryMixes.length]
    const edge = end.map((value, channel) => value - start[channel])
    const amount = Math.max(
      0,
      Math.min(
        1,
        mix.reduce((sum, value, channel) => sum + (value - start[channel]) * edge[channel], 0) /
          edge.reduce((sum, value) => sum + value * value, 0)
      )
    )
    const candidate = start.map((value, channel) => value + amount * edge[channel]) as LayerMix
    const distance = candidate.reduce((sum, value, channel) => sum + (value - mix[channel]) ** 2, 0)
    if (distance < nearestDistance) {
      nearest = candidate
      nearestDistance = distance
    }
  }
  return nearest
}

const TRIANGLE_SCALE = 3.5

function padScale(point: { x: number; y: number }, inverse: boolean): { x: number; y: number } {
  const offsets = [
    (2 * point.y) / 3,
    -point.y / 3 - point.x / SQRT3,
    -point.y / 3 + point.x / SQRT3
  ]
  const radius = -3 * Math.min(...offsets)
  if (radius === 0) return point
  // Expand the unit triangle. Compress each ray to its unchanged signed boundary.
  const limit = Math.min(13, (11 * radius) / (3 * Math.max(...offsets)))
  const mapped =
    radius >= limit
      ? radius
      : inverse
        ? radius <= TRIANGLE_SCALE
          ? radius / TRIANGLE_SCALE
          : 1 + ((radius - TRIANGLE_SCALE) * (limit - 1)) / (limit - TRIANGLE_SCALE)
        : radius <= 1
          ? radius * TRIANGLE_SCALE
          : TRIANGLE_SCALE + ((radius - 1) * (limit - TRIANGLE_SCALE)) / (limit - 1)
  return { x: point.x * (mapped / radius), y: point.y * (mapped / radius) }
}

export function mixPadPoint(mix: LayerMix): { x: number; y: number } {
  return padScale(mixPoint(mix), false)
}

export function padPointMix(point: { x: number; y: number }): LayerMix {
  return pointMix(padScale(point, true))
}

const PERMUTATIONS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0]
]

/**
 * Gives the input channel that feeds each output row: the permutation with the largest
 * sum of coefficients. A tie keeps the earlier permutation, so equal rows show as identity.
 */
export function channelMap(matrix: number[]): number[] {
  const score = (map: number[]): number =>
    map.reduce((sum, input, output) => sum + matrix[output * 3 + input], 0)
  return PERMUTATIONS.reduce((best, map) => (score(map) > score(best) + 1e-9 ? map : best))
}

/** Moves input `input` to output `output`. The input of that output goes to the old output. */
export function swapChannel(matrix: number[], input: number, output: number): number[] {
  const from = channelMap(matrix).indexOf(input)
  const next = [...matrix]
  for (let column = 0; column < 3; column++) {
    next[from * 3 + column] = matrix[output * 3 + column]
    next[output * 3 + column] = matrix[from * 3 + column]
  }
  return next
}
