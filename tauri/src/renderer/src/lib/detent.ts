/** Snap `next` onto a nearby detent; click when the move reaches or crosses one. */
export function detent(
  previous: number,
  next: number,
  detents: number[],
  tolerance: number
): { value: number; click: boolean } {
  const value = detents.find((d) => Math.abs(next - d) <= tolerance) ?? next
  const click = detents.some((d) => (previous < d && value >= d) || (previous > d && value <= d))
  return { value, click }
}
