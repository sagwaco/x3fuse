// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { SfdCube } from '../src/renderer/src/components/SfdCube'
import { cell, COUNT, fillOrder, SIZE } from '../src/renderer/src/lib/sfdCube'

it('fills the SFD RAW cube from the middle layer outward, one layer at a time', () => {
  const order = fillOrder()
  expect(new Set(order).size).toBe(COUNT)
  const layers = order.map((index) => cell(index)[2])
  const blocks = Array.from({ length: SIZE }, (_, i) =>
    layers.slice(i * SIZE * SIZE, (i + 1) * SIZE * SIZE)
  )
  expect(blocks.map((block) => new Set(block).size)).toEqual(Array(SIZE).fill(1))
  expect(blocks.map((block) => block[0])).toEqual([3, 2, 4, 1, 5, 0, 6])
})

/** Floats per particle in the uploaded data. The last one is the glow. */
const STRIDE = 8
let now: number
let frames: Map<number, FrameRequestCallback>
let uploads: Float32Array[]
let loseContext: ReturnType<typeof vi.fn>
let visibility: (visible: boolean) => void

beforeEach(() => {
  vi.useFakeTimers()
  now = 0
  frames = new Map()
  uploads = []
  loseContext = vi.fn()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        visibility = (visible) => callback([{ isIntersecting: visible }])
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
  document.documentElement.style.setProperty('--tone-500', '115 115 115')
  // A WebGL 2 context: constants are their names, and uploads are recorded.
  const gl = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'bufferData'
          ? (_target: unknown, data: Float32Array) => uploads.push(data.slice())
          : key === 'getExtension'
            ? () => ({ loseContext })
            : key === 'getProgramParameter'
              ? () => true
              : key === 'checkFramebufferStatus'
                ? () => 'FRAMEBUFFER_COMPLETE'
                : key === 'drawingBufferWidth'
                  ? 44
                  : typeof key === 'string' && /^[A-Z_0-9]+$/.test(key)
                    ? key
                    : () => ({})
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === 'webgl2' ? gl : null) as never)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const advance = (seconds: number): void =>
  act(() => {
    const end = now + seconds * 1000
    while (now < end && frames.size) {
      now += 16
      const due = [...frames.values()]
      frames.clear()
      for (const callback of due) callback(now)
    }
  })

/** The drawn particles: x, y and glow. Gray particles have no glow. */
const drawn = (): Array<{ x: number; y: number; glow: number }> => {
  const data = uploads.at(-1)!
  return Array.from({ length: data.length / STRIDE }, (_, i) => ({
    x: data[i * STRIDE],
    y: data[i * STRIDE + 1],
    glow: data[i * STRIDE + STRIDE - 1]
  }))
}
const colored = (): number => drawn().filter(({ glow }) => glow > 0).length

it('streams colored particles in one at a time, and each lands with a flash', () => {
  const view = render(<SfdCube fill={0} fusing={false} />)
  advance(0.5)
  expect(colored()).toBe(0)
  view.rerender(<SfdCube fill={1} fusing={false} />)
  let flash = 0
  let burst = 0
  let count = 0
  for (let i = 0; i < 400; i++) {
    advance(0.016)
    burst = Math.max(burst, colored() - count)
    count = colored()
    flash = Math.max(flash, ...drawn().map(({ glow }) => glow))
  }
  // No more than two arrive in a frame. Every gray particle is replaced.
  expect(burst).toBeLessThanOrEqual(2)
  expect(drawn()).toHaveLength(COUNT)
  expect(colored()).toBe(COUNT)
  expect(flash).toBeGreaterThan(1)
})

it('drops colored particles straight down while the cube spins on', () => {
  const view = render(<SfdCube fill={1} fusing={false} />)
  advance(0.5)
  view.rerender(<SfdCube fill={0} fusing={false} />)
  advance(0.1)
  // The gray cube is back at once, with the colored particles falling in front.
  expect(drawn().length - colored()).toBe(COUNT)
  const falling = (): Array<{ x: number; y: number }> =>
    drawn()
      .filter(({ glow }) => glow > 0)
      .sort((a, b) => a.x - b.x || a.y - b.y)
  const before = falling()
  advance(0.2)
  const after = falling()
  expect(after.map(({ x }) => x)).toEqual(before.map(({ x }) => x))
  expect(after.reduce((sum, { y }) => sum + y, 0)).toBeGreaterThan(
    before.reduce((sum, { y }) => sum + y, 0)
  )
  advance(1)
  expect(colored()).toBe(0)
})

it('keeps drawing when particles launch again during their drop', () => {
  const view = render(<SfdCube fill={1} fusing={false} />)
  advance(0.1)
  view.rerender(<SfdCube fill={0} fusing={false} />)
  advance(0.1)
  view.rerender(<SfdCube fill={1} fusing={false} />)
  advance(0.5)
  expect(frames.size).toBe(1)
  advance(4)
  expect(drawn()).toHaveLength(COUNT)
})

it('stops drops and flights at once under reduced motion', () => {
  const media = { matches: false, listener: () => {} }
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return media.matches
    },
    addEventListener: (_: string, listener: () => void) => (media.listener = listener),
    removeEventListener: () => {}
  }))
  const view = render(<SfdCube fill={1} fusing={false} />)
  advance(0.1)
  view.rerender(<SfdCube fill={0} fusing={false} />)
  advance(0.1)
  media.matches = true
  act(() => media.listener())
  advance(0.1)
  expect(drawn()).toHaveLength(COUNT)
  expect(colored()).toBe(0)
  view.rerender(<SfdCube fill={0.5} fusing={false} />)
  advance(0.1)
  expect(colored()).toBe(171)
})

it('spins only while it shows', () => {
  const view = render(<SfdCube fill={0} fusing />)
  advance(0.1)
  expect(frames.size).toBe(1)
  act(() => visibility(false))
  advance(0.1)
  expect(frames.size).toBe(0)
  view.rerender(<SfdCube fill={0.5} fusing />)
  expect(frames.size).toBe(0)
  act(() => visibility(true))
  expect(frames.size).toBe(1)
})

it('keeps its context through a StrictMode remount and releases it on unmount', () => {
  const view = render(
    <StrictMode>
      <SfdCube fill={0} fusing={false} />
    </StrictMode>
  )
  act(() => vi.runAllTimers())
  expect(view.container.querySelector('canvas')).not.toBeNull()
  expect(loseContext).not.toHaveBeenCalled()
  view.unmount()
  act(() => vi.runAllTimers())
  expect(loseContext).toHaveBeenCalledOnce()
})
