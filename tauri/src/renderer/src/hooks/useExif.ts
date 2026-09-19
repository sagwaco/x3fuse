import { useEffect, useState } from 'react'
import type { ExifPair } from '@shared/types'
import { ipc } from '../lib/ipc'

const cache = new Map<string, ExifPair[]>()

/**
 * Fetch curated, display-ready EXIF for the inspector. Returns `'loading'` while
 * the IPC call is in flight, an array (possibly empty) once resolved, or `null`
 * when no path is selected.
 */
export function useExif(path: string | undefined, fileId?: string): ExifPair[] | 'loading' | null {
  const key = JSON.stringify([path, fileId])
  const [state, setState] = useState<{ key: string; pairs: ExifPair[] }>()

  useEffect(() => {
    if (!path) return
    const cached = cache.get(key)
    if (cached) {
      setState({ key, pairs: cached })
      return
    }
    let cancelled = false
    ipc
      .invoke('exif:full', { path })
      .then((pairs) => {
        // Main also returns [] on extraction failure; let a later visit retry it.
        if (pairs.length) {
          cache.set(key, pairs)
          if (cache.size > 32) cache.delete(cache.keys().next().value!)
        }
        if (!cancelled) setState({ key, pairs })
      })
      .catch(() => {
        if (!cancelled) setState({ key, pairs: [] })
      })
    return () => {
      cancelled = true
    }
  }, [path, key])

  if (!path) return null
  return cache.get(key) ?? (state?.key === key ? state.pairs : 'loading')
}
