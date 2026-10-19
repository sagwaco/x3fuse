/** The particle grid of the SFD RAW cube. See `SfdCube`. */

/** Particles on each edge of the cube. Layer 0 is the top layer. */
export const SIZE = 7
export const COUNT = SIZE ** 3
export const MIDDLE = (SIZE - 1) / 2

/** A fixed pseudo-random number from 0 to 1 for `i`. */
export const hash = (i: number): number => {
  const value = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return value - Math.floor(value)
}

/** The x, z and layer of a particle index. */
export const cell = (index: number): [number, number, number] => [
  index % SIZE,
  Math.floor(index / SIZE) % SIZE,
  Math.floor(index / (SIZE * SIZE))
]

/**
 * The particles in the order that they fill: the middle layer first, then
 * outward two layers at a time, the one above and the one below, so the fill
 * ripples out from the middle. The particles of a step fill in a fixed random
 * order, so its surfaces change all the time. A particle index is
 * `x + SIZE * (z + SIZE * layer)`.
 */
export function fillOrder(): number[] {
  return [...Array(MIDDLE + 1).keys()].flatMap((distance) =>
    [...Array(COUNT).keys()]
      .filter((index) => Math.abs(cell(index)[2] - MIDDLE) === distance)
      .sort((a, b) => hash(a) - hash(b))
  )
}
