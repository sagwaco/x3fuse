import { useEffect, useRef, useState } from 'react'

/** Milliseconds that a press stays on after the release. */
const HOLD = 200

/**
 * True while the primary pointer button presses, and for HOLD ms after the
 * release anywhere. Glass controls show their glass for this time.
 */
export function usePress(): [boolean, (event: React.PointerEvent) => void] {
  const [pressed, setPressed] = useState(false)
  // Removes the listeners and the release timer of the last press.
  const stop = useRef(() => {})
  useEffect(() => {
    const last = stop
    return () => last.current()
  }, [])
  const press = (event: React.PointerEvent): void => {
    if (event.button !== 0) return
    // A new press cancels the end of the last one, so it stays on while held.
    stop.current()
    setPressed(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const release = (): void => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      timer = setTimeout(() => setPressed(false), HOLD)
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    stop.current = () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      clearTimeout(timer)
    }
  }
  return [pressed, press]
}
