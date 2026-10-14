// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { X3FFileDTO } from '@shared/types'
import { displayPreviewUrl, previewUrl } from '@shared/preview'
import { DevelopingPreview } from '../src/renderer/src/components/DevelopingPreview'

const { loadSmallPreview, cachedSmallPreview, cachedFitPreview } = vi.hoisted(() => ({
  loadSmallPreview: vi.fn(),
  cachedSmallPreview: vi.fn(),
  cachedFitPreview: vi.fn()
}))
vi.mock('../src/renderer/src/lib/previewImages', () => ({ loadSmallPreview, cachedSmallPreview }))
vi.mock('../src/renderer/src/lib/fitPreviews', () => ({ cachedFitPreview }))
vi.mock('../src/renderer/src/components/FilmstripImage', () => ({
  FilmstripImage: ({ file }: { file: X3FFileDTO }) => (
    <div data-high-res={displayPreviewUrl(file, 'full')} />
  )
}))
vi.mock('../src/renderer/src/components/OrientedImage', () => ({
  OrientedImage: ({ file }: { file: X3FFileDTO }) => (
    <img data-still={displayPreviewUrl(file)} alt="" />
  )
}))

const file = { id: 'a', path: '/a.X3F', fileName: 'a.X3F' } as X3FFileDTO
const edited = {
  ...file,
  edit: { recipe: {}, revision: 1, previewUrl: 'x3f-edit://localhost/saved-a' }
} as X3FFileDTO
const embedded = previewUrl(file.path, 'preview', file.id)
let now: number
let frames: Map<number, FrameRequestCallback>
let uniforms: Record<string, number[]>
let loseContext: ReturnType<typeof vi.fn>
let webgl: boolean
let textures: boolean
let calls: Array<[string, ...unknown[]]>
let boxes: Record<string, number[][]>
let framebuffers: string[]
let errors: string[]
let thumbnail: object
type Fade = {
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  cancel: ReturnType<typeof vi.fn>
  onfinish: (() => void) | null
}
let fades: Fade[]

beforeEach(() => {
  now = 0
  frames = new Map()
  uniforms = { u_spread: [], u_alpha: [] }
  loseContext = vi.fn()
  webgl = true
  textures = true
  calls = []
  boxes = { u_from: [] }
  framebuffers = []
  errors = []
  fades = []
  // jsdom has no Web Animations. The tests end each fade with finish().
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      const fade = { keyframes, options, cancel: vi.fn(), onfinish: null }
      fades.push(fade)
      return fade
    }
  })
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(300)
  thumbnail = { width: 64, height: 48 }
  loadSmallPreview.mockReset().mockResolvedValue(thumbnail)
  cachedSmallPreview.mockReset().mockReturnValue(undefined)
  cachedFitPreview.mockReset().mockReturnValue(undefined)
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  // A WebGL 2 context: constants are their names, and calls are recorded.
  const gl = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'getUniformLocation'
          ? (_program: unknown, name: string) => name
          : key === 'uniform1f'
            ? (location: string, value: number) => uniforms[location]?.push(value)
            : key === 'uniform4fv'
              ? (location: string, value: number[]) => boxes[location]?.push(value)
              : key === 'createTexture'
                ? () => (textures ? {} : null)
                : key === 'getExtension'
                  ? () => ({ loseContext })
                  : key === 'checkFramebufferStatus'
                    ? () => framebuffers.shift() ?? 'FRAMEBUFFER_COMPLETE'
                    : key === 'getError'
                      ? () => (calls.push(['getError']), errors.shift() ?? 'NO_ERROR')
                      : typeof key === 'string' && /^[A-Z_0-9]+$/.test(key)
                        ? key
                        : key.toString().startsWith('drawingBuffer')
                          ? 100
                          : (...args: unknown[]) => (calls.push([String(key), ...args]), {})
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === 'webgl2' && webgl ? gl : null) as never)
})
afterEach(() => {
  cleanup()
  delete (Element.prototype as { animate?: unknown }).animate
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const advance = (ms: number): void =>
  act(() => {
    const end = now + ms
    while (now < end) {
      now += 16
      const due = [...frames.values()]
      frames.clear()
      for (const callback of due) callback(now)
    }
  })
const loaded = (): Promise<void> => act(async () => {})
const last = (name: string): number => uniforms[name].at(-1)!
const cover = (): number =>
  Number(document.querySelector('canvas')!.style.getPropertyValue('--cover'))
const mask = (): string =>
  (document.querySelector('canvas')!.style as { maskImage?: string }).maskImage ?? ''
const finish = (): void => act(() => fades.at(-1)!.onfinish!())
const computedStyle = window.getComputedStyle.bind(window)
/** Shows `value` as the cover of a running fade. Like a Web Animation, it leaves the inline style. */
const compositor = (value: number): void => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
    element instanceof HTMLCanvasElement
      ? ({ getPropertyValue: () => String(value) } as unknown as CSSStyleDeclaration)
      : computedStyle(element, pseudo)
  )
}
const called = (name: string): unknown[][] =>
  calls.filter(([key]) => key === name).map(([, ...args]) => args)

it('shows only particles: blank at first, then a cloud that fades into the preview', async () => {
  const done = vi.fn()
  const view = render(
    <DevelopingPreview file={file} matching developing ready={false} onDone={done} />
  )
  await loaded()
  expect(view.container.querySelectorAll('canvas, img, [data-high-res]')).toHaveLength(1)
  expect(view.getByRole('img', { name: 'a.X3F' })).toBeTruthy()
  // The canvas covers the empty stage from the start; the particles fade in later.
  expect(cover()).toBe(1)
  advance(140)
  expect(last('u_alpha')).toBe(0)
  expect(last('u_spread')).toBe(1)
  // Colors interpolate from the thumbnail; points come from the grid alone.
  expect(called('texImage2D').filter((args) => args.at(-1) === thumbnail)).toHaveLength(1)
  expect(called('texParameteri')).toEqual(
    expect.arrayContaining([
      ['TEXTURE_2D', 'TEXTURE_MIN_FILTER', 'LINEAR'],
      ['TEXTURE_2D', 'TEXTURE_MAG_FILTER', 'LINEAR']
    ])
  )
  // Each frame draws the points, blurs the mipmaps of their frame into a
  // quarter-size glow, then draws the frame and the glow.
  expect(called('texParameteri')).toContainEqual([
    'TEXTURE_2D',
    'TEXTURE_MIN_FILTER',
    'LINEAR_MIPMAP_LINEAR'
  ])
  expect(called('drawArrays').slice(-3)).toEqual([
    ['POINTS', 0, 246 * 184],
    ['TRIANGLES', 0, 3],
    ['TRIANGLES', 0, 3]
  ])
  expect(called('generateMipmap')).toHaveLength(called('drawArrays').length / 3)
  expect(called('viewport').slice(-3)).toEqual([
    [0, 0, 400, 300],
    [0, 0, 100, 75],
    [0, 0, 400, 300]
  ])
  // The frame textures are made once. Errors, which wait for the GPU, are
  // read only then.
  expect(called('texImage2D').filter((args) => args.at(-1) === null)).toHaveLength(2)
  expect(called('getError')).toHaveLength(3)
  advance(1500)
  expect(last('u_alpha')).toBeGreaterThan(0.99)
  expect(last('u_spread')).toBe(1)
  // The opaque canvas hides the preview below it until the cloud fades. A
  // full cover needs no mask.
  const canvas = view.container.querySelector('canvas')!
  expect(canvas.className).toContain('bg-neutral-950')
  expect(mask()).toBe('')
  view.rerender(<DevelopingPreview file={file} matching developing ready onDone={done} />)
  // A radial mask opens the cover from the center while the cloud moves on.
  advance(16)
  expect(fades).toHaveLength(1)
  expect(fades[0].keyframes).toEqual([{ '--cover': 1 }, { '--cover': 0 }])
  expect(mask()).toMatch(/^radial-gradient\(.*var\(--cover\)/)
  expect(fades[0].options).toEqual({ duration: 800, easing: 'ease-in-out', fill: 'forwards' })
  const drawn = called('drawArrays').length
  advance(400)
  expect(called('drawArrays').length).toBe(drawn + 25 * 3)
  expect(last('u_spread')).toBe(1)
  expect(last('u_alpha')).toBeGreaterThan(0.99)
  expect(done).not.toHaveBeenCalled()
  finish()
  expect(done).toHaveBeenCalledOnce()
  expect(frames.size).toBe(0)
  view.unmount()
  expect(loseContext).toHaveBeenCalledOnce()
})

it('settles the particles into the image and stops drawing when the editor stops developing', async () => {
  const view = render(
    <DevelopingPreview file={file} matching developing ready={false} onDone={() => {}} />
  )
  await loaded()
  advance(1500)
  view.rerender(
    <DevelopingPreview file={file} matching developing={false} ready={false} onDone={() => {}} />
  )
  advance(2000)
  expect(last('u_spread')).toBeLessThan(0.001)
  expect(last('u_alpha')).toBeGreaterThan(0.999)
  expect(cover()).toBe(1)
  expect(frames.size).toBe(0)
  view.rerender(
    <DevelopingPreview file={file} matching developing ready={false} onDone={() => {}} />
  )
  expect(frames.size).toBe(1)
})

it('shows a decoded high-resolution preview of the current edit instead of a cloud', async () => {
  cachedFitPreview.mockReturnValue({ width: 6000, height: 4000 })
  const done = vi.fn()
  const view = render(
    <DevelopingPreview file={edited} matching developing ready={false} onDone={done} />
  )
  await loaded()
  expect(cachedFitPreview).toHaveBeenCalledWith('x3f-edit://localhost/saved-a')
  expect(view.container.querySelector('[data-high-res]')).not.toBeNull()
  expect(view.container.querySelector('canvas')).toBeNull()
  expect(loadSmallPreview).not.toHaveBeenCalled()
  view.rerender(<DevelopingPreview file={edited} matching developing ready onDone={done} />)
  expect(done).toHaveBeenCalledOnce()
  expect(view.container.innerHTML).toBe('')
  cleanup()
  // A saved preview of another edit does not count.
  render(
    <DevelopingPreview file={edited} matching={false} developing ready={false} onDone={done} />
  )
  await loaded()
  expect(document.querySelector('[data-high-res]')).toBeNull()
  expect(document.querySelector('canvas[data-developing-preview]')).not.toBeNull()
})

it('colors the cloud from a cached rendered thumbnail of the current edit, else the embedded JPEG', async () => {
  const thumbnail = displayPreviewUrl(edited)
  for (const [matching, cached, url] of [
    [true, true, thumbnail],
    [true, false, embedded],
    [false, true, embedded]
  ] as const) {
    cachedSmallPreview.mockImplementation((key: string) =>
      cached && key === thumbnail ? {} : undefined
    )
    render(
      <DevelopingPreview
        file={edited}
        matching={matching}
        developing
        ready={false}
        onDone={() => {}}
      />
    )
    await loaded()
    expect(loadSmallPreview.mock.lastCall?.[0]).toBe(url)
    cleanup()
  }
})

it('shows the still thumbnail without motion or WebGL 2 and leaves as soon as the preview is ready', async () => {
  for (const setup of [
    () => vi.stubGlobal('matchMedia', () => ({ matches: true })),
    () => vi.stubGlobal('WebGL2RenderingContext', undefined),
    () => (webgl = false),
    () => (textures = false)
  ]) {
    setup()
    const done = vi.fn()
    const view = render(
      <DevelopingPreview file={file} matching developing ready={false} onDone={done} />
    )
    await loaded()
    expect(view.container.querySelector('[data-still]')?.getAttribute('data-still')).toBe(embedded)
    expect(view.container.querySelector('canvas')).toBeNull()
    view.rerender(<DevelopingPreview file={file} matching developing ready onDone={done} />)
    expect(done).toHaveBeenCalledOnce()
    expect(view.container.innerHTML).toBe('')
    view.unmount()
    vi.stubGlobal('matchMedia', undefined)
    vi.stubGlobal('WebGL2RenderingContext', class {})
    webgl = true
    textures = true
  }
})

it('skips the cloud when the preview is ready before the cloud shows', async () => {
  const done = vi.fn()
  render(<DevelopingPreview file={file} matching developing ready onDone={done} />)
  expect(done).toHaveBeenCalledOnce()
  // A cloud that mounts over a ready preview does not hide it.
  expect(cover()).toBe(0)
  expect(mask()).toContain('radial-gradient')
  cleanup()
  // The canvas is still blank, so nothing fades.
  const late = vi.fn()
  const view = render(
    <DevelopingPreview file={file} matching developing ready={false} onDone={late} />
  )
  await loaded()
  advance(100)
  view.rerender(<DevelopingPreview file={file} matching developing ready onDone={late} />)
  advance(16)
  expect(late).toHaveBeenCalledOnce()
  expect(fades).toHaveLength(0)
  expect(frames.size).toBe(0)
})

it('fades a cloud that barely showed from its opaque background', async () => {
  const done = vi.fn()
  const view = render(
    <DevelopingPreview file={file} matching developing ready={false} onDone={done} />
  )
  await loaded()
  advance(160)
  expect(last('u_alpha')).toBeGreaterThan(0)
  expect(last('u_alpha')).toBeLessThan(0.1)
  view.rerender(<DevelopingPreview file={file} matching developing ready onDone={done} />)
  // The background of the canvas, not the faint particles, sets where the fade starts.
  advance(16)
  expect(fades[0].keyframes[0]).toEqual({ '--cover': 1 })
  expect(last('u_alpha')).toBeLessThan(0.1)
  finish()
  expect(done).toHaveBeenCalledOnce()
})

it('fades back in when the preview goes away during the reveal', async () => {
  const done = vi.fn()
  const view = render(
    <DevelopingPreview file={file} matching developing ready={false} onDone={done} />
  )
  await loaded()
  advance(1500)
  view.rerender(<DevelopingPreview file={file} matching developing ready onDone={done} />)
  advance(16)
  compositor(0.4)
  view.rerender(<DevelopingPreview file={file} matching developing ready={false} onDone={done} />)
  advance(16)
  expect(fades[0].cancel).toHaveBeenCalledOnce()
  expect(cover()).toBeGreaterThan(0.4)
  expect(cover()).toBeLessThan(0.5)
  // A finish of the cancelled fade does not end the cloud.
  act(() => fades[0].onfinish!())
  expect(done).not.toHaveBeenCalled()
  advance(1500)
  expect(cover()).toBeGreaterThan(0.99)
  expect(last('u_spread')).toBeGreaterThan(0.95)
  view.rerender(<DevelopingPreview file={file} matching developing ready onDone={done} />)
  advance(16)
  expect(fades).toHaveLength(2)
  expect(done).not.toHaveBeenCalled()
  finish()
  expect(done).toHaveBeenCalledOnce()
})

it('closes the cover smoothly when the preview comes back at once during the reveal', async () => {
  const done = vi.fn()
  const view = render(
    <DevelopingPreview file={file} matching developing ready={false} onDone={done} />
  )
  await loaded()
  advance(1500)
  const ready = (value: boolean): void =>
    view.rerender(<DevelopingPreview file={file} matching developing ready={value} onDone={done} />)
  ready(true)
  advance(16)
  compositor(0.4)
  ready(false)
  advance(16)
  ready(true)
  advance(16)
  // The new fade starts where the canvas is, not at full cover.
  expect(fades).toHaveLength(2)
  expect(fades[1].keyframes[0]['--cover']).toBeGreaterThan(0.4)
  expect(fades[1].keyframes[0]['--cover']).toBeLessThan(0.5)
  // A finish of the cancelled fade does not end the new one.
  act(() => fades[0].onfinish!())
  expect(done).not.toHaveBeenCalled()
  finish()
  expect(done).toHaveBeenCalledOnce()
})

it('keeps the cloud when the preview goes away in the last frame of the fade', async () => {
  const done = vi.fn()
  const view = render(
    <DevelopingPreview file={file} matching developing ready={false} onDone={done} />
  )
  await loaded()
  advance(1500)
  view.rerender(<DevelopingPreview file={file} matching developing ready onDone={done} />)
  advance(16)
  compositor(0)
  view.rerender(<DevelopingPreview file={file} matching developing ready={false} onDone={done} />)
  // The finish event comes before the next animation frame.
  finish()
  expect(done).not.toHaveBeenCalled()
  advance(16)
  expect(fades[0].cancel).toHaveBeenCalledOnce()
  expect(cover()).toBeGreaterThan(0)
  expect(cover()).toBeLessThan(0.1)
  advance(1500)
  expect(cover()).toBeGreaterThan(0.99)
})

it('stops the fade when the cloud unmounts', async () => {
  const done = vi.fn()
  const view = render(
    <DevelopingPreview file={file} matching developing ready={false} onDone={done} />
  )
  await loaded()
  advance(1500)
  view.rerender(<DevelopingPreview file={file} matching developing ready onDone={done} />)
  advance(16)
  view.unmount()
  expect(fades[0].cancel).toHaveBeenCalledOnce()
  // A finish event that was queued before the unmount does not end the cloud.
  act(() => fades[0].onfinish!())
  expect(done).not.toHaveBeenCalled()
  expect(frames.size).toBe(0)
})

it('caps the particles and insets the moving cloud', async () => {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(4000)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(6000)
  render(<DevelopingPreview file={file} matching developing ready={false} onDone={() => {}} />)
  await loaded()
  advance(1000)
  const count = called('drawArrays').at(-3)![2] as number
  expect(count).toBeLessThanOrEqual(600_000)
  expect(count).toBeGreaterThan(594_000)
  // A landscape thumbnail fills the width of the portrait view, inside a 30 pixel margin.
  expect(boxes.u_from.at(-1)).toEqual([30, 1522.5, 3940, 2955])
})

it('shows the still thumbnail when the WebGL context is lost or has no room for a frame', async () => {
  for (const fail of [
    () =>
      act(() => {
        document.querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost'))
      }),
    // The frame, the glow or the frame's mipmaps cannot be allocated at a new size.
    ...[
      [['INCOMPLETE'], []],
      [['FRAMEBUFFER_COMPLETE', 'INCOMPLETE'], []],
      [[], ['OUT_OF_MEMORY']],
      [[], ['NO_ERROR', 'NO_ERROR', 'OUT_OF_MEMORY']]
    ].map(([statuses, failures]) => () => {
      framebuffers = statuses
      errors = failures
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(500)
      advance(16)
    })
  ]) {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    const view = render(
      <DevelopingPreview file={file} matching developing ready={false} onDone={() => {}} />
    )
    await loaded()
    advance(500)
    fail()
    expect(view.container.querySelector('[data-still]')).not.toBeNull()
    expect(view.container.querySelector('canvas')).toBeNull()
    expect(frames.size).toBe(0)
    view.unmount()
  }
})
