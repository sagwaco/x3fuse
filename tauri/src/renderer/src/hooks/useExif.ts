import { useEffect, useState } from 'react'
import type { ExifPair } from '@shared/types'
import { ipc } from '../lib/ipc'

const cache = new Map<string, ExifPair[]>()
type Request = { key: string; path: string; listeners: Set<(pairs: ExifPair[]) => void> }
let running: Request | undefined
let pending: Request | undefined

function pump(): void {
  if (running || !pending) return
  const request = pending
  pending = undefined
  running = request
  void ipc
    .invoke('exif:full', { path: request.path })
    .catch(() => [])
    .then((pairs) => {
      if (pairs.length) {
        cache.set(request.key, pairs)
        if (cache.size > 64) cache.delete(cache.keys().next().value!)
      }
      request.listeners.forEach((listener) => listener(pairs))
    })
    .finally(() => {
      running = undefined
      pump()
    })
}

/** Imported rows are immediate; fallback extraction keeps only the latest selection queued. */
export function useExif(
  path: string | undefined,
  fileId?: string,
  imported?: ExifPair[],
  importing = false
): ExifPair[] | 'loading' | null {
  const key = JSON.stringify([path, fileId])
  const [state, setState] = useState<{ key: string; pairs: ExifPair[] }>()

  useEffect(() => {
    if (!path || imported || importing || cache.has(key)) return
    let request = running?.key === key ? running : pending?.key === key ? pending : undefined
    if (!request) {
      request = { key, path, listeners: new Set() }
      pending = request
    }
    const listener = (pairs: ExifPair[]): void => setState({ key, pairs })
    request.listeners.add(listener)
    pump()
    return () => {
      request.listeners.delete(listener)
      if (pending === request && !request.listeners.size) pending = undefined
    }
  }, [path, key, imported, importing])

  if (!path) return null
  if (imported) return imported
  if (importing) return 'loading'
  return cache.get(key) ?? (state?.key === key ? state.pairs : 'loading')
}
