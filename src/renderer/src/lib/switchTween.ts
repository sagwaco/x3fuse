import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** The duration of a channel switch, in ms. Keep it equal to the CSS transitions. */
export const SWITCH_MS = 300

/**
 * Eases between two values when `key` changes, for example on a channel switch.
 * Returns the value from before the change and the eased progress `t`, 0 to 1.
 * Other changes of `value` do not animate.
 */
export function useSwitchTween<T>(key: unknown, value: T): { from: T; t: number } {
  const last = useRef(value)
  const [tween, setTween] = useState({ from: value, t: 1 })
  // Layout effects run before the paint, so the new value never shows unanimated.
  useLayoutEffect(() => {
    const from = last.current
    if (Object.is(from, value) || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
      return setTween((tween) => (tween.t === 1 ? tween : { from: value, t: 1 }))
    // ponytail: a switch during a switch starts again from the previous target, not the shown value.
    const start = performance.now()
    setTween({ from, t: 0 })
    let frame = requestAnimationFrame(function step(now) {
      const p = Math.min(1, (now - start) / SWITCH_MS)
      setTween({ from, t: p < 0.5 ? 4 * p ** 3 : 1 - (2 - 2 * p) ** 3 / 2 })
      if (p < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    last.current = value
  })
  return tween
}
