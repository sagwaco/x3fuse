import type { Wheel } from '@shared/editor'

/** Fine adjust (Option or Alt) moves the knob this much for each unit of pointer movement. */
const FINE = 0.25
/** How far from its hue line, in wheel radii, the pointer can go before a soft lock lets go. */
const SOFT = 0.2

/** Clamps a dot to the unit disc. Rounding keeps sidecars short and stays inside the disc. */
export function inDisc(x: number, y: number): Pick<Wheel, 'x' | 'y'> {
  const scale = Math.min(1, 1 / Math.hypot(x, y))
  const round = (v: number): number => Math.round(v * scale * 1e4) / 1e4
  return { x: round(x), y: round(y) }
}

export const polar = (saturation: number, hue: number): Pick<Wheel, 'x' | 'y'> =>
  inDisc(saturation * Math.cos(hue), saturation * Math.sin(hue))

/** A drag on a wheel. Positions are in wheel units: 0 at the center, 1 at the rim, y up. */
export interface WheelDrag {
  pointer: number
  /** A drag of the outer knob changes only the hue. */
  outer: boolean
  /** The pointer position without the rim limit, after the grab offset and fine adjust. */
  at: [number, number]
  /** The last pointer position. */
  last: [number, number]
  /** The saturation that a hue-only drag keeps. */
  saturation: number | null
  /** The hue (radians) that Shift locks. */
  hard: number | null
  /** The hue (radians) that a press on the inner knob locks until the pointer leaves its line. */
  soft: number | null
}

export interface WheelKeys {
  /** Shift: keep the hue. */
  shift: boolean
  /** Option or Alt: smaller steps. */
  fine: boolean
  /** Command on macOS, Control elsewhere: keep the saturation. */
  hueOnly: boolean
}

export interface WheelPosition {
  x: number
  y: number
  /** Kept at zero saturation, where x and y cannot hold it. */
  hue: number
}

/**
 * Moves a drag to pointer `p` and gives the knob position, its hue, and the hue line
 * to show (null for none). It updates the locks in `drag`.
 */
export function dragTo(
  drag: WheelDrag,
  p: [number, number],
  keys: WheelKeys,
  current: WheelPosition
): WheelPosition & { guide: number | null } {
  const factor = keys.fine ? FINE : 1
  drag.at = [
    drag.at[0] + (p[0] - drag.last[0]) * factor,
    drag.at[1] + (p[1] - drag.last[1]) * factor
  ]
  drag.last = p
  const [vx, vy] = drag.at
  const saturation = Math.min(1, Math.hypot(current.x, current.y))
  drag.hard = keys.shift ? (drag.hard ?? current.hue) : null
  if (!drag.outer) drag.saturation = keys.hueOnly ? (drag.saturation ?? saturation) : null
  // Fine adjust and a saturation lock turn the soft lock off. The pointer turns it off
  // when it leaves the line.
  if (drag.soft !== null) {
    const off = Math.abs(vx * Math.sin(drag.soft) - vy * Math.cos(drag.soft))
    if (keys.fine || keys.hueOnly || off > SOFT) drag.soft = null
  }
  const lock = drag.hard ?? drag.soft
  if (drag.saturation !== null) {
    // Both the hue and the saturation are locked, so nothing moves.
    if (lock !== null) return { ...current, guide: null }
    const hue = Math.hypot(vx, vy) > 1e-3 ? Math.atan2(vy, vx) : current.hue
    return { ...polar(drag.saturation, hue), hue, guide: null }
  }
  if (lock !== null) {
    // On the line from the center through the hue. The center is the end of the line.
    const along = Math.max(0, vx * Math.cos(lock) + vy * Math.sin(lock))
    return { ...polar(Math.min(1, along), lock), hue: lock, guide: lock }
  }
  const { x, y } = inDisc(vx, vy)
  return { x, y, hue: x || y ? Math.atan2(y, x) : current.hue, guide: null }
}
