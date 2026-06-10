import os from 'os'
import { autoConcurrency } from '@shared/concurrency'

/**
 * Run `worker` over `items` with at most `limit` in flight. Lanes pull the next
 * index until the list is exhausted, so a slow item never blocks the others.
 * A throwing worker doesn't strand its lane: errors are collected and the first
 * one is rethrown after all lanes drain.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length))
  let next = 0
  const errors: unknown[] = []
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        const i = next++
        try {
          await worker(items[i], i)
        } catch (e) {
          errors.push(e)
        }
      }
    })
  )
  if (errors.length > 0) throw errors[0]
}

/**
 * Effective pool size, by precedence: the X3FUSE_CONCURRENCY env var
 * (testing/troubleshooting override) > the user's concurrency setting when
 * manual (>= 1) > auto, derived from the CPU core count (see autoConcurrency).
 */
export function resolveConcurrency(setting: number): number {
  const env = Number(process.env.X3FUSE_CONCURRENCY)
  if (Number.isInteger(env) && env >= 1) return env
  if (Number.isInteger(setting) && setting >= 1) return setting
  const cores = os.availableParallelism?.() ?? os.cpus().length
  return autoConcurrency(cores)
}
