import { useEffect, useMemo, useState } from 'react'
import type { ExifPair, X3FFileDTO } from '@shared/types'
import { ipc } from '../lib/ipc'

const cache = new Map<string, ExifPair[]>()
type Request = { key: string; path: string; listeners: Set<(pairs: ExifPair[]) => void> }
let running: Request | undefined
const pending = new Map<string, Request>()

function pump(): void {
  if (running || !pending.size) return
  const request = pending.values().next().value!
  pending.delete(request.key)
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

type ExifSource = Pick<X3FFileDTO, 'exif' | 'pending'> & { path?: string; id?: string }
const sourceKey = (file: ExifSource): string => JSON.stringify([file.path, file.id])

/** Imported rows are immediate; fallback requests are shared and queued only while selected. */
export function useSelectionExif(files: readonly ExifSource[]): ExifPair[][] | 'loading' {
  const [state, setState] = useState<{
    files: readonly ExifSource[]
    rows: Map<string, ExifPair[]>
  }>()
  useEffect(() => {
    // Retain this selection's cache hits even when later requests evict them.
    setState({
      files,
      rows: new Map(
        files.flatMap((file) => {
          const key = sourceKey(file)
          const pairs = cache.get(key)
          return pairs ? [[key, pairs] as const] : []
        })
      )
    })
    const unsubscribe = files.flatMap((file) => {
      const key = sourceKey(file)
      if (!file.path || file.exif || file.pending || cache.has(key)) return []
      let request = running?.key === key ? running : pending.get(key)
      if (!request) {
        request = { key, path: file.path, listeners: new Set() }
        pending.set(key, request)
      }
      const listener = (pairs: ExifPair[]): void =>
        setState((previous) => ({
          files,
          rows: new Map(previous?.files === files ? previous.rows : []).set(key, pairs)
        }))
      request.listeners.add(listener)
      return [
        () => {
          request.listeners.delete(listener)
          if (pending.get(key) === request && !request.listeners.size) pending.delete(key)
        }
      ]
    })
    pump()
    return () => unsubscribe.forEach((off) => off())
  }, [files])

  const rows = files.map((file) => {
    if (!file.path) return []
    if (file.exif) return file.exif
    if (file.pending) return undefined
    const key = sourceKey(file)
    return cache.get(key) ?? (state?.files === files ? state.rows.get(key) : undefined)
  })
  return rows.every((row) => row !== undefined) ? rows : 'loading'
}

export function useExif(
  path: string | undefined,
  fileId?: string,
  imported?: ExifPair[],
  importing = false
): ExifPair[] | 'loading' | null {
  const files = useMemo(
    () => [{ path, id: fileId, exif: imported, pending: importing }],
    [path, fileId, imported, importing]
  )
  const rows = useSelectionExif(files)
  return !path ? null : rows === 'loading' ? rows : rows[0]
}
