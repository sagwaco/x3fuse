// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { ScopeMenu } from '../src/renderer/src/components/ScopeMenu'
import { ColorScope } from '../src/renderer/src/components/ColorScope'
import { useScopeImage } from '../src/renderer/src/hooks/useScopeImage'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))

const image = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]) }
const context = {
  setTransform: vi.fn(),
  drawImage: vi.fn(),
  getImageData: vi.fn(() => image),
  scale: vi.fn(),
  beginPath: vi.fn(),
  arc: vi.fn(),
  stroke: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  fillText: vi.fn(),
  fillRect: vi.fn(),
  strokeRect: vi.fn(),
  setLineDash: vi.fn(),
  closePath: vi.fn(),
  fill: vi.fn()
}
let bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[]
let preview: string
let previewId = 0

beforeEach(() => {
  preview = `preview:${++previewId}`
  bitmaps = []
  context.getImageData.mockImplementation(() => ({ ...image, data: image.data.slice() }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, blob: async () => new Blob() }))
  )
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      const bitmap = { width: 640, height: 480, close: vi.fn() }
      bitmaps.push(bitmap)
      return bitmap
    })
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  )
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(274)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
  let saved = { ...DEFAULT_SETTINGS }
  invoke.mockImplementation(async (channel, patch) => {
    if (channel === 'settings:set') saved = { ...saved, ...patch }
    return saved
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('scope menu', () => {
  it('selects a native menu option and restores the saved scope on remount', async () => {
    invoke.mockResolvedValueOnce('waveform')
    const first = render(<ScopeMenu />)
    const trigger = screen.getByRole('button', { name: 'Scope view' })
    expect(trigger.textContent).toBe('RGB Parade')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(invoke).toHaveBeenCalledWith(
      'menu:popup',
      expect.objectContaining({
        items: [
          { value: 'histogram', label: 'Histogram', checked: false },
          { value: 'rgbParade', label: 'RGB Parade', checked: true },
          { value: 'waveform', label: 'Waveform', checked: false },
          { value: 'vectorscope', label: 'Vectorscope', checked: false }
        ]
      })
    )
    await waitFor(() => expect(trigger.textContent).toBe('Waveform'))
    expect(invoke).toHaveBeenCalledWith('settings:set', { inspectorScopeMode: 'waveform' })
    first.unmount()
    await act(async () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
      await useSettingsStore.getState().load()
    })
    render(<ScopeMenu />)
    const restored = screen.getByRole('button', { name: 'Scope view' })
    expect(restored.textContent).toBe('Waveform')
    invoke.mockResolvedValueOnce(null)
    fireEvent.click(restored)
    await waitFor(() => expect(restored.getAttribute('aria-expanded')).toBe('false'))
    expect(restored.textContent).toBe('Waveform')
  })
})

describe('scope preview', () => {
  it.each(['waveform', 'rgbParade'] as const)(
    'keeps percent signs on the %s axis tick labels',
    async (mode) => {
      render(<ColorScope url={preview} mode={mode} />)
      await screen.findByRole('img')
      for (const label of ['0%', '25%', '50%', '75%', '100%']) {
        expect(context.fillText).toHaveBeenCalledWith(label, expect.any(Number), expect.any(Number))
      }
      expect(context.fillText.mock.calls.some(([label]) => label === '%')).toBe(false)
    }
  )

  it('reuses cropped, oriented pixels when switching modes and draws at device resolution', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    const view = render(
      <ColorScope url={preview} orientation={6} aspectRatio={2} mode="rgbParade" />
    )
    expect(screen.queryByRole('status')).toBeNull()
    const canvas = (await screen.findByRole('img', { name: 'RGB Parade' })) as HTMLCanvasElement
    await waitFor(() => expect(context.fill).toHaveBeenCalled())
    expect(context.drawImage).toHaveBeenCalledWith(bitmaps[0], 0, 80, 640, 320, 0, 0, 640, 320)
    expect(context.setTransform).toHaveBeenCalledWith(0, 1, -1, 0, 320, 0)
    expect(context.drawImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0, 160, 320)
    expect(context.getImageData).toHaveBeenCalledWith(0, 0, 160, 320)
    expect(canvas.width).toBe(548)
    expect(canvas.height).toBe(400)
    for (const mode of ['histogram', 'waveform', 'vectorscope'] as const) {
      view.rerender(<ColorScope url={preview} orientation={6} aspectRatio={2} mode={mode} />)
      expect(await screen.findByRole('img')).toBe(canvas)
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(createImageBitmap).toHaveBeenCalledTimes(1)
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1)
    view.rerender(<ColorScope url={preview} orientation={1} aspectRatio={2} mode="waveform" />)
    await screen.findByRole('img')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(['rgbParade', 'waveform', 'vectorscope'] as const)(
    'uses round antialiased points in %s without the old channel legend',
    async (mode) => {
      render(<ColorScope url={preview} mode={mode} />)
      await screen.findByRole('img')
      expect(context.arc).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        0.75,
        0,
        Math.PI * 2
      )
      expect(context.fill).toHaveBeenCalled()
      expect(context.fillRect).not.toHaveBeenCalled()
      if (mode !== 'vectorscope') {
        expect(context.fillText.mock.calls.some(([label]) => /^[RGBY]$/.test(label))).toBe(false)
      }
    }
  )

  it('shows no preview on failure and closes a decoded bitmap if reading pixels fails', async () => {
    context.getImageData.mockImplementationOnce(() => {
      throw new Error('read failed')
    })
    render(<ColorScope url={preview} mode="waveform" />)
    await screen.findByText('No preview available')
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale decode and closes its bitmap after a different file is selected', async () => {
    let finish!: (bitmap: unknown) => void
    vi.mocked(createImageBitmap).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const hook = renderHook(({ url }) => useScopeImage(url), { initialProps: { url: preview } })
    await waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1))
    hook.rerender({ url: `${preview}:next` })
    expect(hook.result.current).toBe('loading')
    await waitFor(() => expect(hook.result.current).toEqual(image))
    const stale = { width: 1, height: 1, close: vi.fn() }
    await act(async () => finish(stale))
    expect(stale.close).toHaveBeenCalledOnce()
    // A shared decode may finish into its cache, but stale pixels never reach the scope.
    expect(context.getImageData).toHaveBeenCalledOnce()
    expect(hook.result.current).toEqual(image)
  })

  it('waits one second before showing its Skeleton and restarts the delay for a new selection', () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}))
    const view = render(<ColorScope url={preview} mode="waveform" />)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    expect(screen.queryByText('No preview available')).toBeNull()
    act(() => vi.advanceTimersByTime(999))
    expect(screen.queryByRole('status')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading scope')
    expect(view.container.querySelector('.rt-Skeleton')).not.toBeNull()

    view.rerender(<ColorScope url={`${preview}:next`} mode="waveform" />)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    act(() => vi.advanceTimersByTime(999))
    expect(screen.queryByRole('status')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('copies a completed scope synchronously on revisit and remount without recomputing it', async () => {
    context.getImageData.mockReturnValueOnce(image).mockReturnValueOnce({
      ...image,
      data: new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255])
    })
    const view = render(<ColorScope url={preview} mode="waveform" />)
    await screen.findByRole('img')
    view.rerender(<ColorScope url={`${preview}:next`} mode="waveform" />)
    expect(screen.queryByRole('img')).toBeNull()
    await screen.findByRole('img')
    context.fill.mockClear()
    context.drawImage.mockClear()
    view.rerender(<ColorScope url={preview} mode="waveform" />)
    expect(screen.getByRole('img')).toBeTruthy()
    expect(context.fill).not.toHaveBeenCalled()
    expect(context.drawImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0)
    expect(view.container.querySelector('.rt-Skeleton')).toBeNull()
    view.unmount()

    render(<ColorScope url={preview} mode="waveform" />)
    expect((screen.getByRole('img') as HTMLCanvasElement).width).toBe(274)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(createImageBitmap).toHaveBeenCalledTimes(2)
  })

  it('does not reuse pixels after a file at the same path is imported as a new queue row', async () => {
    const hook = renderHook(
      ({ fileId }) => useScopeImage(`${preview}?rev=${fileId}`, undefined, 1, fileId),
      {
        initialProps: { fileId: 'first-import' }
      }
    )
    await waitFor(() => expect(hook.result.current).toEqual(image))
    hook.rerender({ fileId: 'second-import' })
    expect(hook.result.current).toBe('loading')
    await waitFor(() => expect(hook.result.current).toEqual(image))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not redraw for unchanged window dimensions but refreshes the backing pixel ratio', async () => {
    vi.stubGlobal('devicePixelRatio', 1)
    render(<ColorScope url={preview} mode="waveform" />)
    const canvas = (await screen.findByRole('img')) as HTMLCanvasElement
    context.fill.mockClear()
    context.drawImage.mockClear()
    fireEvent(window, new Event('resize'))
    expect(context.fill).not.toHaveBeenCalled()
    expect(context.drawImage).not.toHaveBeenCalled()
    vi.stubGlobal('devicePixelRatio', 2)
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(canvas.width).toBe(548))
    expect(canvas.height).toBe(400)
    expect(context.fill).toHaveBeenCalled()
  })

  it('restores cached pixels when a quick revisit remounts the canvas before the next image loads', async () => {
    const view = render(<ColorScope url={preview} mode="waveform" />)
    const first = await screen.findByRole('img')
    vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {}))
    view.rerender(<ColorScope url={`${preview}:pending`} mode="waveform" />)
    expect(screen.queryByRole('img')).toBeNull()
    context.fill.mockClear()
    context.drawImage.mockClear()
    view.rerender(<ColorScope url={preview} mode="waveform" />)
    expect(screen.getByRole('img')).not.toBe(first)
    expect(context.drawImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0)
    expect(context.fill).not.toHaveBeenCalled()
  })
})
