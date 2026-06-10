import { useEffect, useState } from 'react'
import type { ExifPair } from '@shared/types'
import { ipc } from '../lib/ipc'

/**
 * Fetch curated, display-ready EXIF for the inspector. Returns `'loading'` while
 * the IPC call is in flight, an array (possibly empty) once resolved, or `null`
 * when no path is selected.
 */
export function useExif(path: string | undefined): ExifPair[] | 'loading' | null {
  const [state, setState] = useState<ExifPair[] | 'loading' | null>(null)

  useEffect(() => {
    if (!path) {
      setState(null)
      return
    }
    let cancelled = false
    setState('loading')
    ipc
      .invoke('exif:full', { path })
      .then((pairs) => {
        if (!cancelled) setState(pairs)
      })
      .catch(() => {
        if (!cancelled) setState([])
      })
    return () => {
      cancelled = true
    }
  }, [path])

  return state
}
