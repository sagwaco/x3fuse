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
 * one layer at a time outward, the upper layer before the lower one. A layer
 * fills in a fixed random order, so its surface changes all the time. A
 * particle index is `x + SIZE * (z + SIZE * layer)`.
 */
export function fillOrder(): number[] {
  const layers = [...Array(SIZE).keys()].sort(
    (a, b) => Math.abs(a - MIDDLE) - Math.abs(b - MIDDLE) || a - b
  )
  return layers.flatMap((layer) =>
    [...Array(SIZE * SIZE).keys()]
      .map((spot) => spot + SIZE * SIZE * layer)
      .sort((a, b) => hash(a) - hash(b))
  )
}
