import { describe, it, expect, afterEach } from 'vitest'
import { resolveConcurrency, runWithConcurrency } from '../src/main/services/concurrency'
import { autoConcurrency } from '@shared/concurrency'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

describe('runWithConcurrency', () => {
  it('never exceeds the limit and processes every item exactly once', async () => {
    const items = [0, 1, 2, 3, 4, 5]
    const gates = items.map(() => deferred())
    const processed: number[] = []
    let inFlight = 0
    let maxInFlight = 0

    const run = runWithConcurrency(items, 2, async (item) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gates[item].promise
      processed.push(item)
      inFlight--
    })

    await tick(5)
    expect(inFlight).toBe(2)
    for (const gate of gates) {
      gate.resolve()
      await tick(5)
    }
    await run

    expect(maxInFlight).toBe(2)
    expect(processed.sort((a, b) => a - b)).toEqual(items)
  })

  it('handles limit greater than the item count', async () => {
    const processed: number[] = []
    await runWithConcurrency([1, 2], 8, async (item) => {
      processed.push(item)
    })
    expect(processed.sort()).toEqual([1, 2])
  })

  it('preserves order with limit 1', async () => {
    const processed: number[] = []
    await runWithConcurrency([3, 1, 2], 1, async (item) => {
      await tick()
      processed.push(item)
    })
    expect(processed).toEqual([3, 1, 2])
  })

  it('a throwing worker does not block remaining items', async () => {
    const processed: number[] = []
    await expect(
      runWithConcurrency([0, 1, 2, 3], 2, async (item) => {
        if (item === 1) throw new Error('boom')
        processed.push(item)
      })
    ).rejects.toThrow('boom')
    expect(processed.sort((a, b) => a - b)).toEqual([0, 2, 3])
  })
})

describe('autoConcurrency', () => {
  it('is cores/2 clamped to 1..4', () => {
    expect(autoConcurrency(1)).toBe(1)
    expect(autoConcurrency(2)).toBe(1)
    expect(autoConcurrency(4)).toBe(2)
    expect(autoConcurrency(8)).toBe(4)
    expect(autoConcurrency(32)).toBe(4)
  })
})

describe('resolveConcurrency', () => {
  afterEach(() => {
    delete process.env.X3FUSE_CONCURRENCY
  })

  it('uses the manual setting when >= 1', () => {
    expect(resolveConcurrency(3)).toBe(3)
    expect(resolveConcurrency(1)).toBe(1)
  })

  it('falls back to the core-derived auto value when the setting is 0 (auto)', () => {
    const limit = resolveConcurrency(0)
    expect(limit).toBeGreaterThanOrEqual(1)
    expect(limit).toBeLessThanOrEqual(4)
  })

  it('lets the X3FUSE_CONCURRENCY env override everything', () => {
    process.env.X3FUSE_CONCURRENCY = '6'
    expect(resolveConcurrency(2)).toBe(6)
    expect(resolveConcurrency(0)).toBe(6)
  })
})
