import { useEffect, useState } from 'react'

/** Fast requests never show a placeholder; a new selection gets its own delay. */
export function useDelayedLoading(
  loading: boolean,
  key: string | undefined,
  delayMs = 1000
): boolean {
  const [shownFor, setShownFor] = useState<string>()
  useEffect(() => {
    setShownFor(undefined)
    if (!loading || key === undefined) return
    const timer = setTimeout(() => setShownFor(key), delayMs)
    return () => clearTimeout(timer)
  }, [loading, key, delayMs])
  return loading && key !== undefined && shownFor === key
}
