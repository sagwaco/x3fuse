import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const OUT_MS = 110
const OUT_STEP_MS = 10
const IN_MS = 400
const IN_STEP_MS = 30
// The longest total stagger, so a toolbar with many buttons still settles fast.
const MAX_STAGGER_MS = 250

// A damped spring sampled as a CSS linear() easing. It overshoots about 13%.
const SPRING = `linear(${Array.from({ length: 25 }, (_, i) => {
  const t = i / 24
  return i === 24 ? 1 : (1 - Math.exp(-7 * t) * Math.cos(11 * t)).toFixed(3)
}).join(', ')})`
const OVERSHOOT = 'cubic-bezier(0.34, 1.56, 0.64, 1)'

// jsdom has no element.animate, and reduced motion asks for no animation.
function canAnimate(): boolean {
  return (
    typeof Element !== 'undefined' &&
    typeof Element.prototype.animate === 'function' &&
    !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
}

function play(root: HTMLElement | null, entering: boolean): Animation[] {
  const items = [...(root?.querySelectorAll<HTMLElement>('[data-swap] button') ?? [])].sort(
    (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
  )
  const step = Math.min(entering ? IN_STEP_MS : OUT_STEP_MS, MAX_STAGGER_MS / items.length)
  const easing = !entering
    ? 'ease-in'
    : CSS.supports('animation-timing-function', 'linear(0, 1)')
      ? SPRING
      : OVERSHOOT
  const hidden = { transform: 'scale(0)', opacity: 0 }
  const visible = { transform: 'scale(1)', opacity: 1 }
  return items.map((item, index) => {
    // On a reversal mid-bounce, only the new animation moves the item.
    item.getAnimations?.().forEach((animation) => animation.cancel())
    return item.animate(entering ? [hidden, visible] : [visible, hidden], {
      duration: entering ? IN_MS : OUT_MS,
      delay: index * step,
      easing,
      fill: entering ? 'backwards' : 'forwards'
    })
  })
}

/**
 * Swaps toolbar buttons from left to right, including buttons inside groups.
 * They also scale in when the toolbar mounts. `shown` is the state to render and `leaving`
 * is true during the exit, when the old buttons must ignore input. Without
 * animation support, `shown` follows `target` at once.
 */
export function useToolbarSwap(target: boolean): {
  ref: React.RefObject<HTMLDivElement>
  shown: boolean
  leaving: boolean
} {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState({ shown: target, leaving: false })
  const animated = canAnimate()
  const shown = animated ? state.shown : target
  useEffect(() => {
    if (!animated || target === state.shown) {
      setState((s) => (s.shown === target && !s.leaving ? s : { shown: target, leaving: false }))
      return
    }
    const out = play(ref.current, false)
    let live = true
    setState((s) => ({ ...s, leaving: true }))
    // A cancelled animation rejects: a newer target took over, so do nothing.
    Promise.all(out.map((a) => a.finished)).then(
      () => live && setState({ shown: target, leaving: false }),
      () => undefined
    )
    return () => {
      live = false
      out.forEach((a) => a.cancel())
    }
  }, [target, state.shown, animated])
  // This also runs on mount, so a toolbar scales in when its screen opens.
  useLayoutEffect(() => {
    if (!animated) return
    const entering = play(ref.current, true)
    return () => entering.forEach((a) => a.cancel())
  }, [shown, animated])
  return { ref, shown, leaving: animated && state.leaving }
}
