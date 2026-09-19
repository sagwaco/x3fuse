import { useEffect, useState } from 'react'

/** Fast requests never show a placeholder; a new selection gets its own delay. */
export function useDelayedLoading(loading: boolean, key: string | undefined): boolean {
  const [shownFor, setShownFor] = useState<string>()
  useEffect(() => {
    setShownFor(undefined)
    if (!loading || key === undefined) return
    const timer = setTimeout(() => setShownFor(key), 1000)
    return () => clearTimeout(timer)
  }, [loading, key])
  return loading && key !== undefined && shownFor === key
}
