import { useState } from 'react'

/** Milliseconds that a press stays on after the release. */
const HOLD = 200

/**
 * True while the primary pointer button presses, and for HOLD ms after the
 * release anywhere. Glass controls show their glass for this time.
 */
export function usePress(): [boolean, (event: React.PointerEvent) => void] {
  const [pressed, setPressed] = useState(false)
  const press = (event: React.PointerEvent): void => {
    if (event.button !== 0) return
    setPressed(true)
    const release = (): void => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      setTimeout(() => setPressed(false), HOLD)
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
  }
  return [pressed, press]
}
