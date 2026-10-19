// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { SfdCube } from '../src/renderer/src/components/SfdCube'
import { cell, COUNT, fillOrder, SIZE } from '../src/renderer/src/lib/sfdCube'

it('fills the SFD RAW cube from the middle layer outward, two layers at a time', () => {
  const order = fillOrder()
  expect(new Set(order).size).toBe(COUNT)
  const layers = order.map((index) => cell(index)[2])
  const area = SIZE * SIZE
  expect(new Set(layers.slice(0, area))).toEqual(new Set([3]))
  for (const [step, pair] of [
    [1, [2, 4]],
    [2, [1, 5]],
    [3, [0, 6]]
  ] as const) {
    const block = layers.slice((2 * step - 1) * area, (2 * step + 1) * area)
    expect(new Set(block)).toEqual(new Set(pair))
    // The two layers fill together, not one after the other.
    expect(new Set(block.slice(0, area))).toEqual(new Set(pair))
  }
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

type Dot = { x: number; y: number; size: number; glow: number }
/** The drawn dots: x, y, size and glow. Gray particles and the wireframe have no glow. */
const dots = (): Dot[] => {
  const data = uploads.at(-1)!
  return Array.from({ length: data.length / STRIDE }, (_, i) => ({
    x: data[i * STRIDE],
    y: data[i * STRIDE + 1],
    size: data[i * STRIDE + 2],
    glow: data[i * STRIDE + STRIDE - 1]
  }))
}
/** Wireframe dots are smaller than any particle. */
const wire = (): Dot[] => dots().filter(({ size }) => size < 0.6)
const drawn = (): Dot[] => dots().filter(({ size }) => size >= 0.6)
const colored = (): number => drawn().filter(({ glow }) => glow > 0).length

it('outlines the cube with a wireframe', () => {
  render(<SfdCube fill={0} fusing={false} />)
  advance(0.1)
  const box = wire()
  expect(box.length).toBeGreaterThan(0)
  for (const axis of ['x', 'y'] as const) {
    const inside = drawn().map((dot) => dot[axis])
    const outside = box.map((dot) => dot[axis])
    expect(Math.max(...outside)).toBeGreaterThan(Math.max(...inside))
    expect(Math.min(...outside)).toBeLessThan(Math.min(...inside))
  }
})

it('hides the gray cube during a merge, and shows each particle as it lands with a flash', () => {
  const view = render(<SfdCube fill={0} fusing={false} />)
  advance(0.1)
  expect(drawn()).toHaveLength(COUNT)
  view.rerender(<SfdCube fill={0} fusing />)
  advance(0.5)
  // The gray particles fade out.
  expect(drawn()).toHaveLength(0)
  view.rerender(<SfdCube fill={1} fusing />)
  let flash = 0
  let burst = 0
  let count = 0
  let gray = 0
  for (let i = 0; i < 400; i++) {
    advance(0.016)
    burst = Math.max(burst, colored() - count)
    count = colored()
    gray = Math.max(gray, drawn().length - count)
    flash = Math.max(flash, ...drawn().map(({ glow }) => glow))
  }
  // No more than two arrive in a frame, and no gray particle shows.
  expect(burst).toBeLessThanOrEqual(2)
  expect(gray).toBe(0)
  expect(flash).toBeGreaterThan(1)
})

it('brings the gray cube back when a merge stops', () => {
  const view = render(<SfdCube fill={0} fusing />)
  advance(0.5)
  view.rerender(<SfdCube fill={0.2} fusing />)
  advance(2)
  expect(colored()).toBeGreaterThan(0)
  view.rerender(<SfdCube fill={0} fusing={false} />)
  advance(0.3)
  // The cube stays empty until the drop ends.
  expect(drawn().length - colored()).toBe(0)
  advance(2)
  expect(drawn()).toHaveLength(COUNT)
  expect(colored()).toBe(0)
})

it('fills while the photo changes to the other RAW, and completes when it shows', () => {
  const view = render(<SfdCube fill={0} fusing={false} />)
  advance(0.5)
  view.rerender(<SfdCube fill={1} fusing={false} switching />)
  advance(1)
  // Most particles are in, but gray ones wait for the photo.
  expect(colored()).toBeGreaterThan(COUNT / 2)
  expect(drawn().length - colored()).toBeGreaterThan(0)
  view.rerender(<SfdCube fill={1} fusing={false} />)
  advance(0.3)
  // Every gray particle is replaced.
  expect(drawn()).toHaveLength(COUNT)
  expect(colored()).toBe(COUNT)
})

it('drops colored particles straight down, then fades the gray cube in from the top', () => {
  const view = render(<SfdCube fill={1} fusing={false} />)
  advance(0.5)
  view.rerender(<SfdCube fill={0} fusing={false} />)
  advance(0.1)
  const gray = (): Array<{ y: number }> => drawn().filter(({ glow }) => glow === 0)
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
  // The cube stays empty until the drop ends.
  expect(gray()).toHaveLength(0)
  advance(0.5)
  // Then the upper layers come back first. The canvas y points down.
  expect(colored()).toBe(0)
  const shown = gray()
  expect(shown.length).toBeGreaterThan(0)
  expect(shown.length).toBeLessThan(COUNT)
  expect(shown.reduce((sum, { y }) => sum + y, 0) / shown.length).toBeLessThan(0)
  advance(1)
  expect(drawn()).toHaveLength(COUNT)
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
