import { ipc } from './ipc'

/**
 * One byte-based LRU for the decoded and encoded preview images that this window keeps.
 * The backend gives the total image-memory budget; this window uses half of it.
 */
export type Held<T> = {
  key: string
  value: T
  bytes: number
  /** Viewers that show this image. A held entry is never dropped. */
  users: number
  /** Made before the last Clear: drop as soon as no viewer holds it. */
  stale: boolean
  release?: () => void
}

const MiB = 1024 * 1024
/** Half of the conservative 1 GiB total budget, until the backend gives its value. */
const DEFAULT_BUDGET = 512 * MiB
const held = new Map<string, Held<unknown>>()
let budget = DEFAULT_BUDGET
let total = 0
let epoch = 0
let connected = false
let warm = new Set<string>()
const clearListeners = new Set<() => void>()

function connect(): void {
  if (connected) return
  connected = true
  try {
    ipc.on('cache:cleared', clearMemory)
    void ipc.invoke('cache:memoryBudget').then(
      (bytes) => {
        if (typeof bytes === 'number' && bytes > 0) setBudget(bytes / 2)
      },
      () => {}
    )
  } catch {
    // Without the native bridge, keep the default budget.
  }
}

function setBudget(bytes: number): void {
  budget = bytes
  trimMemory()
}

/** The Clear count. A producer keeps the value from its start to find out-of-date results. */
export function memoryEpoch(): number {
  connect()
  return epoch
}

export function getHeld<T>(key: string): Held<T> | undefined {
  const entry = held.get(key) as Held<T> | undefined
  if (entry) {
    held.delete(key)
    held.set(key, entry)
  }
  return entry
}

/**
 * Keep a value. A producer from before the last Clear gives `since`; its value
 * stays only while a viewer holds it. A current entry for the key stays, and the
 * new value is released. A stale entry gives its key to a current value and is
 * released when its last viewer leaves. Eviction waits a microtask, so that the
 * caller can deliver and pin the entry first.
 */
export function hold<T>(
  key: string,
  value: T,
  bytes: number,
  release?: () => void,
  since = epoch
): Held<T> {
  connect()
  const stale = since !== epoch
  const existing = getHeld<T>(key)
  if (existing && (existing.stale ? stale : true)) {
    release?.()
    return existing
  }
  if (existing) {
    held.delete(key)
    if (!existing.users) settle(existing)
  }
  const entry: Held<T> = { key, value, bytes, users: 0, stale, release }
  held.set(key, entry as Held<unknown>)
  total += bytes
  queueMicrotask(trimMemory)
  return entry
}

function settle(entry: Held<unknown>): void {
  total -= entry.bytes
  entry.release?.()
}

function drop(entry: Held<unknown>): void {
  held.delete(entry.key)
  settle(entry)
}

export function forget(key: string): void {
  const entry = held.get(key)
  if (entry && !entry.users) drop(entry)
}

/** Lets a remounted viewer take the same entry before an eviction. */
export function unhold(entry: Held<unknown>): void {
  entry.users--
  // A replaced entry is not in the map any more; its last viewer releases it.
  if (!entry.users && held.get(entry.key) !== entry) settle(entry)
  else queueMicrotask(trimMemory)
}

/** Entries that the nearest photos use stay while the budget allows other evictions. */
export function keepWarm(keys: Iterable<string>): void {
  warm = new Set(keys)
  trimMemory()
}

export function trimMemory(): void {
  for (const entry of [...held.values()]) {
    if (entry.users) continue
    if (entry.stale || (total > budget && !warm.has(entry.key))) drop(entry)
  }
  // Warm entries go last, but they cannot keep the cache above its budget.
  for (const entry of [...held.values()]) {
    if (total <= budget) break
    if (!entry.users) drop(entry)
  }
}

/** Called after `cache:cleared`: drop idle images and mark held images as out of date. */
export function onMemoryClear(listener: () => void): () => void {
  clearListeners.add(listener)
  return () => clearListeners.delete(listener)
}

export function clearMemory(): void {
  epoch++
  for (const entry of [...held.values()]) {
    if (entry.users) entry.stale = true
    else drop(entry)
  }
  clearListeners.forEach((listener) => listener())
}

export function memoryBytes(): number {
  return total
}
