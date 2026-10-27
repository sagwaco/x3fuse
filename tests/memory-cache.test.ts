// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke, on: () => () => {} } }))
let memory: typeof import('../src/renderer/src/lib/memoryCache')
const MiB = 1024 * 1024

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

beforeEach(async () => {
  vi.resetModules()
  // Each window keeps half of the total budget: 100 MiB here.
  invoke.mockReset().mockResolvedValue(200 * MiB)
  memory = await import('../src/renderer/src/lib/memoryCache')
  memory.memoryEpoch()
  await settle()
})

it('uses half of the backend budget, and a conservative half GiB without one', async () => {
  const release = vi.fn()
  memory.hold('a', 1, 90 * MiB, release)
  await settle()
  expect(release).not.toHaveBeenCalled()
  memory.hold('b', 1, 20 * MiB)
  await settle()
  expect(release).toHaveBeenCalledOnce()
  expect(invoke).toHaveBeenCalledWith('cache:memoryBudget')

  vi.resetModules()
  invoke.mockReset().mockRejectedValue(new Error('No command'))
  memory = await import('../src/renderer/src/lib/memoryCache')
  const kept = vi.fn()
  memory.hold('c', 1, 500 * MiB, kept)
  await settle()
  expect(kept).not.toHaveBeenCalled()
  memory.hold('d', 1, 20 * MiB)
  await settle()
  expect(kept).toHaveBeenCalledOnce()
})

it('admits a new entry over the budget so that its producer can pin it first', async () => {
  const old = memory.hold('old', 1, 60 * MiB)
  old.users++
  const release = vi.fn()
  const added = memory.hold('new', 2, 60 * MiB, release)
  added.users++
  await settle()
  expect(release).not.toHaveBeenCalled()
  expect(memory.getHeld('new')).toBe(added)
  memory.unhold(added)
  await settle()
  expect(release).toHaveBeenCalledOnce()
  expect(memory.getHeld('new')).toBeUndefined()
  expect(memory.getHeld('old')).toBe(old)
})

it('drops other entries before warm ones, but warm entries cannot exceed the budget', async () => {
  const warm = vi.fn(),
    other = vi.fn()
  memory.keepWarm(['warm'])
  memory.hold('warm', 1, 40 * MiB, warm)
  memory.hold('other', 1, 40 * MiB, other)
  memory.hold('newest', 1, 40 * MiB)
  await settle()
  expect(other).toHaveBeenCalledOnce()
  expect(warm).not.toHaveBeenCalled()
  memory.keepWarm(['big'])
  const big = vi.fn()
  memory.hold('big', 1, 150 * MiB, big)
  await settle()
  expect(big).toHaveBeenCalledOnce()
  expect(memory.memoryBytes()).toBeLessThanOrEqual(100 * MiB)
})

it('keeps displayed entries over a Clear and gives their key to new work', async () => {
  const shownRelease = vi.fn()
  const shown = memory.hold('key', 'before', 10 * MiB, shownRelease)
  shown.users++
  const idle = vi.fn()
  memory.hold('idle', 1, 10 * MiB, idle)
  const before = memory.memoryEpoch()
  const cleared = vi.fn()
  memory.onMemoryClear(cleared)
  memory.clearMemory()
  expect(cleared).toHaveBeenCalledOnce()
  expect(idle).toHaveBeenCalledOnce()
  expect(shownRelease).not.toHaveBeenCalled()
  expect(memory.memoryEpoch()).toBe(before + 1)

  // A late producer from before the Clear reuses the displayed entry.
  const late = vi.fn()
  expect(memory.hold('key', 'late', 10 * MiB, late, before)).toBe(shown)
  expect(late).toHaveBeenCalledOnce()

  // New work replaces the stale entry; the old one goes when its viewer leaves.
  const fresh = memory.hold('key', 'after', 10 * MiB)
  expect(fresh).not.toBe(shown)
  expect(fresh.stale).toBe(false)
  expect(memory.getHeld('key')).toBe(fresh)
  memory.unhold(shown)
  expect(shownRelease).toHaveBeenCalledOnce()
  await settle()
  expect(memory.getHeld('key')).toBe(fresh)
  expect(memory.memoryBytes()).toBe(10 * MiB)
})
