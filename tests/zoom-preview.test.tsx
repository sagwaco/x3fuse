// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { X3FFileDTO } from '@shared/types'
import { defaultRecipe } from '@shared/editor'
import { displayPreviewUrl } from '@shared/preview'
import { ZoomablePreview } from '../src/renderer/src/components/ZoomablePreview'
import { ZoomControls } from '../src/renderer/src/components/ZoomControls'
import { PreviewMinimap } from '../src/renderer/src/components/PreviewMinimap'
import { usePreviewStore } from '../src/renderer/src/stores/previewStore'
import { runCommand } from '../src/renderer/src/lib/commands'

const { invoke, loadFrame } = vi.hoisted(() => ({ invoke: vi.fn(), loadFrame: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))
vi.mock('../src/renderer/src/lib/frames', () => ({ loadFrame }))
type PendingFrame = {
  url: string
  signal: AbortSignal
  frame: { image: ImageBitmap; width: number; height: number; release: () => void }
  finish: () => void
  fail: () => void
}
function holdFrames(): PendingFrame[] {
  const pending: PendingFrame[] = []
  loadFrame.mockImplementation(
    (url: string, signal: AbortSignal) =>
      new Promise((resolve, reject) => {
        const frame = { image: {} as ImageBitmap, width: 800, height: 600, release: vi.fn() }
        pending.push({
          url,
          signal,
          frame,
          finish: () => resolve(frame),
          fail: () => reject(new Error('gone'))
        })
      })
  )
  return pending
}
vi.mock('../src/renderer/src/components/OrientedImage', () => ({
  OrientedImage: ({
    file,
    containerClassName
  }: {
    file: X3FFileDTO
    containerClassName?: string
  }) => (
    <div className={containerClassName}>
      <img data-small-preview src={displayPreviewUrl(file)} alt={file.fileName} />
    </div>
  )
}))
vi.mock('../src/renderer/src/components/FilmstripImage', async () => {
  const { useState } = await import('react')
  return {
    FilmstripImage: function MockFilmstripImage({
      file,
      fullResolution = false,
      onDimensions,
      containerClassName,
      className
    }: {
      file: X3FFileDTO
      fullResolution?: boolean
      onDimensions?: (dimensions: { width: number; height: number }, url: string) => void
      containerClassName?: string
      className?: string
    }) {
      const [ready, setReady] = useState(false)
      return (
        <div className={containerClassName}>
          <img
            src={`${file.path}?v=fit`}
            alt={file.fileName}
            aria-hidden={!ready}
            className={className}
            data-full-resolution={fullResolution}
            onLoad={(event) => {
              setReady(true)
              onDimensions?.(
                {
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight
                },
                displayPreviewUrl(file, 'full')
              )
            }}
            onError={() => setReady(false)}
          />
        </div>
      )
    }
  }
})

const file: X3FFileDTO = {
  id: 'a',
  path: '/photos/a.X3F',
  fileName: 'a.X3F'
}
let resize: (width: number, height: number) => void
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

function flushFrames(): void {
  act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach((callback) => callback(performance.now()))
  })
}

function wheel(target: Element, options: WheelEventInit): void {
  fireEvent.wheel(target, options)
  flushFrames()
}

function pointerMove(target: Element, options: PointerEventInit): void {
  fireEvent.pointerMove(target, options)
  flushFrames()
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null)
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: vi.fn(() => [])
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        if (target.getAttribute('aria-label') !== 'Image preview') return
        resize = (width, height) =>
          this.callback(
            [{ target, contentRect: { width, height } } as ResizeObserverEntry],
            this as unknown as ResizeObserver
          )
        resize(800, 600)
      }
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId: number
      isPrimary: boolean
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options)
        this.pointerId = options.pointerId ?? 1
        this.isPrimary = options.isPrimary ?? true
      }
    }
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function loadImage(width = 1600, height = 1200): HTMLImageElement {
  const image = document.querySelector('.preview-image img') as HTMLImageElement
  Object.defineProperties(image, {
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true }
  })
  fireEvent.load(image)
  return image
}

function PreviewWithControls({ file }: { file: X3FFileDTO }): React.JSX.Element {
  return (
    <>
      <ZoomControls />
      <ZoomablePreview file={file} />
    </>
  )
}

function setup(width = 1600, height = 1200) {
  const result = render(<PreviewWithControls key={file.id} file={file} />)
  const image = loadImage(width, height)
  const surface = screen.getByRole('region', { name: 'Image preview' })
  const media = image.parentElement!.parentElement!
  surface.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 800,
      height: 600
    }) as DOMRect
  surface.setPointerCapture = vi.fn()
  surface.hasPointerCapture = () => true
  surface.releasePointerCapture = vi.fn()
  return { ...result, image, surface, media }
}

async function chooseZoom(value: string): Promise<void> {
  const trigger = screen.getByRole('button', { name: 'Zoom level' })
  invoke.mockResolvedValueOnce(value)
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
}

describe('filmstrip zoom preview', () => {
  it('reports a paint only after the image draws, not for known dimensions', () => {
    const onPaint = vi.fn()
    render(
      <ZoomablePreview file={file} naturalSize={{ width: 6000, height: 4000 }} onPaint={onPaint} />
    )
    expect(onPaint).not.toHaveBeenCalled()
    loadImage()
    expect(onPaint).toHaveBeenCalledOnce()
    expect(onPaint).toHaveBeenCalledWith(displayPreviewUrl(file, 'full'), expect.any(Object))
  })

  it('uses the saved edited thumbnail for the Info navigator before and during zoom', () => {
    const edited = {
      ...file,
      edit: { recipe: defaultRecipe(), revision: 1, previewUrl: 'x3f-edit://localhost/saved-a' }
    }
    usePreviewStore.setState({ minimap: null })
    render(<PreviewMinimap file={edited} />)
    expect(screen.getByRole('img').getAttribute('src')).toBe(
      'x3f-edit://localhost/saved-a?v=thumbnail'
    )
    act(() =>
      usePreviewStore.setState({
        minimap: {
          fileId: file.id,
          aspectRatio: 1.5,
          x: 0.25,
          y: 0.25,
          width: 0.5,
          height: 0.5,
          panTo: vi.fn()
        }
      })
    )
    expect(screen.getByRole('region', { name: 'Preview minimap' })).toBeTruthy()
    expect(screen.getByRole('img').getAttribute('src')).toBe(
      'x3f-edit://localhost/saved-a?v=thumbnail'
    )
    act(() => usePreviewStore.setState({ minimap: null }))
  })

  it('uses medium at Fit and requests full only beyond Fit without changing image geometry', () => {
    const { surface, media, image } = setup(6000, 4000)
    const fitTransform = media.style.transform
    expect(image.dataset.fullResolution).toBe('false')
    expect(media.style.width).toBe('6000px')
    expect(media.style.height).toBe('4000px')
    expect(usePreviewStore.getState().controls?.scale).toBeCloseTo(800 / 6000)
    render(<PreviewMinimap file={file} />)

    fireEvent.keyDown(surface, { key: '1' })
    expect(image.dataset.fullResolution).toBe('true')
    expect(document.querySelector('.preview-image img')).toBe(image)
    const zoomTransform = media.style.transform
    // A completed quality upgrade does not alter the original coordinate system.
    fireEvent.load(image)
    expect(media.style.transform).toBe(zoomTransform)
    expect(media.style.width).toBe('6000px')
    const minimapImage = document
      .querySelector('[aria-label="Preview minimap"]')
      ?.previousElementSibling?.querySelector('img')
    expect(minimapImage?.hasAttribute('data-small-preview')).toBe(true)

    fireEvent.keyDown(surface, { key: '0' })
    expect(image.dataset.fullResolution).toBe('false')
    expect(document.querySelector('.preview-image img')).toBe(image)
    expect(media.style.transform).toBe(fitTransform)
    fireEvent.keyDown(surface, { key: '-' })
    expect(image.dataset.fullResolution).toBe('false')
  })

  it('coalesces gesture bursts, flushes the last drag on release, and cancels stale frames', () => {
    const { surface, media, image, unmount } = setup()
    fireEvent.click(surface)
    const published = vi.fn()
    const unsubscribe = usePreviewStore.subscribe(published)
    vi.mocked(media.getAnimations).mockClear()
    for (let i = 0; i < 40; i++) fireEvent.wheel(surface, { deltaX: 2, deltaY: 1 })
    expect(frames.size).toBe(1)
    expect(media.style.transform).toBe('translate(0px, 0px) scale(1)')
    expect(published).not.toHaveBeenCalled()
    expect(media.getAnimations).toHaveBeenCalledOnce()
    flushFrames()
    expect(media.style.transform).toBe('translate(-80px, -40px) scale(1)')
    expect(published).toHaveBeenCalledOnce()
    expect(document.querySelector('.preview-image img')).toBe(image)

    fireEvent.pointerDown(surface, { button: 0, clientX: 200, clientY: 200 })
    fireEvent.pointerMove(surface, { clientX: 220, clientY: 210 })
    fireEvent.pointerMove(surface, { clientX: 240, clientY: 230 })
    expect(frames.size).toBe(1)
    fireEvent.pointerUp(surface)
    expect(frames.size).toBe(0)
    expect(media.style.transform).toBe('translate(-40px, -10px) scale(1)')

    wheel(surface, { deltaX: 10000, deltaY: 10000 })
    published.mockClear()
    fireEvent.wheel(surface, { deltaX: 10000, deltaY: 10000 })
    expect(frames.size).toBe(0)
    expect(published).not.toHaveBeenCalled()
    fireEvent.wheel(surface, { deltaX: -20, deltaY: -20 })
    expect(frames.size).toBe(1)
    unmount()
    expect(frames.size).toBe(0)
    expect(usePreviewStore.getState().controls).toBeNull()
    unsubscribe()
  })

  it('applies a discrete zoom to the newest gesture state before the next frame', () => {
    const { surface, media } = setup()
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: -Math.log(2) / 0.01 })
    expect(frames.size).toBe(1)
    fireEvent.click(surface)
    expect(frames.size).toBe(0)
    expect(media.style.transform).toBe('translate(0px, 0px) scale(0.5)')
  })

  it('centers the clicked image point and updates the minimap, then returns to Fit', () => {
    const { surface, media } = setup()
    surface.getBoundingClientRect = () =>
      ({ left: 100, top: 80, width: 800, height: 600 }) as DOMRect
    fireEvent.click(surface, { clientX: 650, clientY: 430, detail: 1 })
    expect(media.style.transform).toBe('translate(-300px, -100px) scale(1)')
    expect(usePreviewStore.getState().minimap).toMatchObject({
      x: 0.4375,
      width: 0.5,
      height: 0.5
    })
    fireEvent.click(surface, { clientX: 650, clientY: 430, detail: 1 })
    expect(media.style.transform).toBe('translate(0px, 0px) scale(0.5)')
  })

  it('clamps click centering at image edges and centers a fully visible axis', () => {
    const { surface, media } = setup(600, 1600)
    fireEvent.click(surface, { clientX: 500, clientY: 590, detail: 1 })
    expect(media.style.transform).toBe('translate(0px, -500px) scale(1)')
    fireEvent.click(surface, { clientX: 500, clientY: 590, detail: 1 })
    fireEvent.click(surface, { clientX: 400, clientY: 360, detail: 1 })
    expect(media.style.transform).toBe('translate(0px, -160px) scale(1)')
  })

  it('eases discrete zooms using only transforms and keeps gestures and resize immediate', () => {
    const { surface, media } = setup()
    expect(media.style.width).toBe('1600px')
    expect(media.style.height).toBe('1200px')
    expect(media.dataset.zoomAnimated).toBe('false')
    fireEvent.click(surface)
    expect(media.dataset.zoomAnimated).toBe('true')
    expect(media.style.width).toBe('1600px')
    expect(media.style.height).toBe('1200px')
    wheel(surface, { deltaX: 20, deltaY: 10 })
    expect(media.dataset.zoomAnimated).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(media.dataset.zoomAnimated).toBe('true')
    wheel(surface, { ctrlKey: true, deltaY: 10 })
    expect(media.dataset.zoomAnimated).toBe('false')
    fireEvent.keyDown(surface, { key: '0' })
    expect(media.dataset.zoomAnimated).toBe('true')
    act(() => resize(640, 480))
    expect(media.dataset.zoomAnimated).toBe('false')
    expect(media.style.transform).toContain('scale(0.4)')
  })

  it('continues panning from the displayed position when interrupting an eased zoom', () => {
    const { surface, media } = setup()
    fireEvent.click(surface)
    vi.mocked(media.getAnimations).mockReturnValueOnce([{} as Animation])
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      transform: 'matrix(0.75, 0, 0, 0.75, 40, 20)'
    } as CSSStyleDeclaration)
    const matrix = vi.fn(() => ({ a: 0.75, e: 40, f: 20 }))
    vi.stubGlobal('DOMMatrixReadOnly', matrix)
    wheel(surface, { deltaX: 10, deltaY: 5 })
    expect(matrix).toHaveBeenCalledWith('matrix(0.75, 0, 0, 0.75, 40, 20)')
    expect(media.style.transform).toBe('translate(30px, 15px) scale(0.75)')
    expect(media.dataset.zoomAnimated).toBe('false')
    expect(usePreviewStore.getState().controls!.scale).toBe(0.75)
  })

  it('steps from below Fit to Fit to 100%, and returns any zoom above Fit to Fit', async () => {
    const { surface, media } = setup()
    const dropdown = screen.getByRole('button', { name: 'Zoom level' })
    await chooseZoom('25')
    fireEvent.click(surface)
    expect(dropdown.textContent).toBe('Fit')
    expect(media.style.transform).toContain('scale(0.5)')
    fireEvent.click(surface)
    expect(dropdown.textContent).toBe('100%')
    fireEvent.click(surface)
    expect(dropdown.textContent).toBe('Fit')

    // A numeric zoom equal to Fit still advances to 100%.
    await chooseZoom('50')
    fireEvent.click(surface)
    expect(dropdown.textContent).toBe('100%')

    for (const value of ['75', '100', '125', '200']) {
      await chooseZoom(value)
      fireEvent.click(surface)
      expect(dropdown.textContent).toBe('Fit')
      expect(media.style.transform).toContain('scale(0.5)')
    }
  })

  it('returns to Fit when the image fits at its natural size', async () => {
    const { surface } = setup(400, 300)
    const dropdown = screen.getByRole('button', { name: 'Zoom level' })
    await chooseZoom('50')
    fireEvent.click(surface)
    expect(dropdown.textContent).toBe('Fit')
    await chooseZoom('200')
    fireEvent.click(surface)
    expect(dropdown.textContent).toBe('Fit')
  })

  it('fits the JPEG, toggles true 100%, and keeps toolbar controls separate from gestures', async () => {
    const { surface, media } = setup()
    expect(media.style.transform).toContain('scale(0.5)')
    expect(surface.style.cursor).toBe('zoom-in')
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Zoom out', 'Zoom in', 'Zoom level'])
    const dropdown = screen.getByRole('button', { name: 'Zoom level' })
    expect(dropdown.textContent).toBe('Fit')
    fireEvent.click(surface)
    expect(media.style.transform).toContain('scale(1)')
    expect(surface.style.cursor).toBe('grab')
    expect(dropdown.textContent).toBe('100%')
    fireEvent.click(surface)
    expect(media.style.transform).toContain('scale(0.5)')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(media.style.transform).toContain('scale(0.625)')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(media.style.transform).toContain('scale(0.5)')
    fireEvent.doubleClick(screen.getByRole('group'))
    expect(media.style.transform).toContain('scale(0.5)')
    await chooseZoom('100')
    expect(media.style.transform).toContain('scale(1)')
    await chooseZoom('fit')
    expect(dropdown.textContent).toBe('Fit')
  })

  it('anchors pinch zoom at the pointer, pans with two-finger scrolling, and clamps the edges', () => {
    const { surface, media } = setup()
    const pinch = new WheelEvent('wheel', {
      deltaY: -Math.log(2) / 0.01,
      ctrlKey: true,
      clientX: 600,
      clientY: 400,
      bubbles: true,
      cancelable: true
    })
    fireEvent(surface, pinch)
    flushFrames()
    expect(pinch.defaultPrevented).toBe(true)
    expect(media.style.transform).toContain('scale(1)')
    expect(media.style.transform).toContain('translate(-200px, -100px)')
    wheel(surface, { deltaX: 50, deltaY: 80 })
    expect(media.style.transform).toContain('translate(-250px, -180px)')
    wheel(surface, { deltaX: 10000, deltaY: 10000 })
    expect(media.style.transform).toContain('translate(-400px, -300px)')
    wheel(surface, { deltaX: -10000, deltaY: -10000 })
    expect(media.style.transform).toContain('translate(400px, 300px)')
    fireEvent.click(surface)
    expect(media.style.transform).toContain('translate(0px, 0px)')
    wheel(surface, { deltaX: 50, deltaY: 50 })
    expect(media.style.transform).toContain('translate(0px, 0px)')
  })

  it('captures a primary drag and stops panning on release or cancellation', () => {
    const { surface, media } = setup()
    fireEvent.click(surface)
    fireEvent.pointerDown(surface, { button: 0, clientX: 200, clientY: 200 })
    expect(surface.setPointerCapture).toHaveBeenCalledWith(1)
    pointerMove(surface, { clientX: 300, clientY: 250 })
    expect(media.style.transform).toContain('translate(100px, 50px)')
    fireEvent.pointerUp(surface)
    expect(surface.releasePointerCapture).toHaveBeenCalledWith(1)
    fireEvent.click(surface)
    expect(media.style.transform).toContain('scale(1)')
    pointerMove(surface, { clientX: 500, clientY: 500 })
    expect(media.style.transform).toContain('translate(100px, 50px)')
    fireEvent.pointerDown(surface, { button: 0 })
    fireEvent.pointerCancel(surface)
    pointerMove(surface, { clientX: 500, clientY: 500 })
    expect(media.style.transform).toContain('translate(100px, 50px)')
    fireEvent.pointerDown(surface, { button: 2 })
    pointerMove(surface, { clientX: 500, clientY: 500 })
    expect(media.style.transform).toContain('translate(100px, 50px)')
  })

  it('recomputes Fit on resize and resets it when a different file is selected', () => {
    const { surface, media, rerender } = setup(1200, 1600)
    expect(media.style.transform).toContain('scale(0.375)')
    act(() => resize(400, 300))
    expect(media.style.transform).toContain('scale(0.1875)')
    fireEvent.click(surface)
    expect(media.style.transform).toContain('scale(1)')
    wheel(surface, { deltaX: 500, deltaY: 500 })
    act(() => resize(2000, 2000))
    expect(media.style.transform).toContain('translate(0px, 0px)')
    act(() => resize(400, 300))
    expect(media.style.transform).toContain('translate(0px, 0px)')
    rerender(<PreviewWithControls key="b" file={{ ...file, id: 'b', path: '/photos/b.X3F' }} />)
    loadImage()
    expect(screen.getByRole('button', { name: 'Zoom level' }).textContent).toBe('Fit')
  })

  it('keeps the toolbar undimmed but disabled while navigating to a loading preview', () => {
    const preview = (active: X3FFileDTO | null) => (
      <>
        <ZoomControls />
        {active && <ZoomablePreview key={active.id} file={active} />}
      </>
    )
    const { rerender } = render(preview(file))
    loadImage()
    const toolbar = screen.getByRole('group', { name: 'Zoom controls' })
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByRole('button', { name: 'Zoom level' }).textContent).not.toBe('Fit')

    rerender(preview({ ...file, id: 'b', path: '/photos/b.X3F' }))
    expect(screen.getByRole('group', { name: 'Zoom controls' })).toBe(toolbar)
    expect(usePreviewStore.getState().activeFileId).toBe('b')
    expect(usePreviewStore.getState().controls).toBeNull()
    expect(screen.getByRole('button', { name: 'Zoom level' }).textContent).toBe('Fit')
    for (const button of screen.getAllByRole('button') as HTMLButtonElement[]) {
      expect(button.disabled).toBe(true)
      expect(button.classList.contains('disabled:opacity-100')).toBe(true)
      expect(button.classList.contains('disabled:opacity-50')).toBe(false)
      fireEvent.click(button)
      fireEvent.keyDown(button, { key: 'Enter' })
    }
    expect(invoke).not.toHaveBeenCalled()
    expect(usePreviewStore.getState().controls).toBeNull()

    loadImage(1200, 1600)
    expect(usePreviewStore.getState().controls).toMatchObject({ fileId: 'b', zoom: null })
    expect(screen.getByRole('button', { name: 'Zoom level' }).textContent).toBe('Fit')
    for (const button of screen.getAllByRole('button') as HTMLButtonElement[]) {
      expect(button.disabled).toBe(false)
      expect(button.classList.contains('disabled:opacity-100')).toBe(false)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(usePreviewStore.getState().controls!.zoom).toBeGreaterThan(0)

    // Leaving while another preview is still loading must also clear its identity.
    rerender(preview({ ...file, id: 'c', path: '/photos/c.X3F' }))
    rerender(preview(null))
    expect(usePreviewStore.getState().activeFileId).toBeNull()
    expect(usePreviewStore.getState().controls).toBeNull()
    for (const button of screen.getAllByRole('button') as HTMLButtonElement[]) {
      expect(button.disabled).toBe(true)
      expect(button.classList.contains('disabled:opacity-50')).toBe(true)
      expect(button.classList.contains('disabled:opacity-100')).toBe(false)
    }
  })

  it('supports keyboard zoom and bounds extreme gestures', () => {
    const { surface, media } = setup()
    fireEvent.keyDown(surface, { key: '1' })
    expect(media.style.transform).toContain('scale(1)')
    fireEvent.keyDown(surface, { key: '+' })
    expect(media.style.transform).toContain('scale(1.25)')
    fireEvent.keyDown(surface, { key: '-' })
    expect(media.style.transform).toContain('scale(1)')
    wheel(surface, { ctrlKey: true, deltaY: -100000 })
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(media.style.transform).toContain('scale(8)')
    wheel(surface, { ctrlKey: true, deltaY: 100000 })
    expect((screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(media.style.transform).toContain('scale(0.1)')
    fireEvent.keyDown(surface, { key: '0' })
    expect(screen.getByRole('button', { name: 'Zoom level' }).textContent).toBe('Fit')
  })

  it('zooms from the menu commands, and leaves keys with modifiers to them', () => {
    const { surface, media } = setup()
    const run = (name: Parameters<typeof runCommand>[0]): boolean => {
      let ran = false
      act(() => void (ran = runCommand(name)))
      return ran
    }
    expect(run('zoomActual')).toBe(true)
    expect(media.style.transform).toContain('scale(1)')
    expect(run('zoomIn')).toBe(true)
    expect(media.style.transform).toContain('scale(1.25)')
    expect(run('zoomOut')).toBe(true)
    expect(media.style.transform).toContain('scale(1)')
    // ⌥⌘0 is Actual Size, not the 0 key of the preview, which fits.
    fireEvent.keyDown(surface, { key: '0', ctrlKey: true, altKey: true })
    expect(media.style.transform).toContain('scale(1)')
    expect(run('zoomFit')).toBe(true)
    expect(screen.getByRole('button', { name: 'Zoom level' }).textContent).toBe('Fit')
    cleanup()
    expect(run('zoomFit')).toBe(false)
  })

  it('disables controls until a preview loads, including pending and failed previews', () => {
    const result = render(<PreviewWithControls key="pending" file={{ ...file, pending: true }} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(document.querySelector('.preview-image img')?.getAttribute('data-full-resolution')).toBe(
      'false'
    )
    expect(
      screen.getAllByRole('button').every((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true)
    result.rerender(<PreviewWithControls key="failed" file={file} />)
    // Zoom geometry is unavailable until the medium preview reports native dimensions.
    fireEvent.error(document.querySelector('.preview-image img')!)
    expect(
      screen.getAllByRole('button').every((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true)
  })

  it('enables zoom from medium dimensions before metadata arrives and keeps it ready afterward', () => {
    const result = render(<PreviewWithControls file={{ ...file, pending: true }} />)
    loadImage()
    expect(usePreviewStore.getState().controls?.fileId).toBe(file.id)
    result.rerender(
      <PreviewWithControls file={{ ...file, pending: false, orientation: 6, aspectRatio: 1 }} />
    )
    expect(usePreviewStore.getState().controls?.fileId).toBe(file.id)
    expect(document.querySelector('.rt-Skeleton')).toBeNull()
    expect(screen.getByRole('img').getAttribute('src')).toContain('v=fit')
    expect(screen.getByRole('img').getAttribute('data-full-resolution')).toBe('false')
  })

  it('offers native zoom presets and preserves a custom percentage after gesture zoom', async () => {
    const { media } = setup()
    const dropdown = screen.getByRole('button', { name: 'Zoom level' })
    fireEvent.keyDown(dropdown, { key: 'ArrowDown' })
    const request = invoke.mock.calls.at(-1)![1]
    expect(request.items.map((item: { label: string }) => item.label)).toEqual([
      'Fit',
      '25%',
      '50%',
      '75%',
      '100%',
      '125%',
      '150%',
      '175%',
      '200%'
    ])
    expect(request.items[0].checked).toBe(true)
    await waitFor(() => expect(dropdown.getAttribute('aria-expanded')).toBe('false'))
    for (const percent of [25, 50, 75, 100, 125, 150, 175, 200]) {
      await chooseZoom(String(percent))
      expect(media.style.transform).toContain(`scale(${percent / 100})`)
    }
    await chooseZoom('fit')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(dropdown.textContent).toBe('63%')
    const queueNavigation = vi.fn()
    document.addEventListener('keydown', queueNavigation)
    try {
      fireEvent.keyDown(dropdown, { key: 'ArrowDown' })
      expect(invoke.mock.calls.at(-1)![1].items.at(-1)).toEqual({
        value: '62.5',
        label: '63%',
        checked: true,
        disabled: true
      })
      await waitFor(() => expect(dropdown.getAttribute('aria-expanded')).toBe('false'))
      expect(media.style.transform).toContain('scale(0.625)')
      await chooseZoom('25')
      expect(media.style.transform).toContain('scale(0.25)')
      expect(queueNavigation).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', queueNavigation)
    }
  })

  it('closes the native zoom menu when its preview becomes unavailable', async () => {
    let dismiss!: (value: null) => void
    invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        dismiss = resolve
      })
    )
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom level' }))
    const id = invoke.mock.calls.at(-1)![1].id
    act(() => usePreviewStore.setState({ controls: null }))
    expect(invoke).toHaveBeenCalledWith('menu:close', id)
    const dropdown = screen.getByRole('button', { name: 'Zoom level' }) as HTMLButtonElement
    expect(dropdown.disabled).toBe(true)
    const calls = invoke.mock.calls.length
    fireEvent.keyDown(dropdown, { key: 'Enter' })
    expect(invoke).toHaveBeenCalledTimes(calls)
    await act(async () => dismiss(null))
  })

  it('keeps the Info minimap in sync and lets users drag the window without jumping', () => {
    const { surface, media, unmount } = setup()
    render(<PreviewMinimap file={file} />)
    expect(screen.queryByRole('region', { name: 'Preview minimap' })).toBeNull()
    fireEvent.click(surface)
    const minimap = screen.getByRole('region', { name: 'Preview minimap' })
    const rectangle = minimap.firstElementChild as HTMLElement
    expect(rectangle.style.left).toBe('25%')
    expect(rectangle.style.top).toBe('25%')
    expect(rectangle.style.width).toBe('50%')
    expect(rectangle.style.height).toBe('50%')
    minimap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 150 }) as DOMRect
    minimap.setPointerCapture = vi.fn()
    minimap.hasPointerCapture = () => true
    minimap.releasePointerCapture = vi.fn()

    // Grab off-center inside the rectangle: pointer-down must not recenter it.
    fireEvent.pointerDown(minimap, { button: 0, clientX: 70, clientY: 60 })
    expect(media.style.transform).toContain('translate(0px, 0px)')
    fireEvent.pointerMove(minimap, { clientX: 80, clientY: 65 })
    fireEvent.pointerMove(minimap, { clientX: 90, clientY: 75 })
    expect(frames.size).toBe(1)
    expect(rectangle.style.left).toBe('25%')
    fireEvent.pointerUp(minimap)
    expect(frames.size).toBe(0)
    expect(parseFloat(rectangle.style.left)).toBeCloseTo(35)
    expect(parseFloat(rectangle.style.top)).toBeCloseTo(35)
    expect(usePreviewStore.getState().minimap!.x).toBeCloseTo(0.35)
    pointerMove(minimap, { clientX: 200, clientY: 150 })
    expect(parseFloat(rectangle.style.left)).toBeCloseTo(35)
    expect(media.style.transform).toContain('scale(1)')

    // Clicking outside recenters, with both the image and map clamped at the edge.
    fireEvent.pointerDown(minimap, { button: 0, clientX: 199, clientY: 149 })
    expect(rectangle.style.left).toBe('50%')
    expect(rectangle.style.top).toBe('50%')
    expect(media.style.transform).toContain('translate(-400px, -300px)')
    fireEvent.pointerCancel(minimap)
    pointerMove(minimap, { clientX: 0, clientY: 0 })
    expect(rectangle.style.left).toBe('50%')
    fireEvent.keyDown(minimap, { key: 'ArrowLeft' })
    expect(parseFloat(rectangle.style.left)).toBeCloseTo(45)

    fireEvent.keyDown(surface, { key: '0' })
    expect(screen.queryByRole('region', { name: 'Preview minimap' })).toBeNull()
    fireEvent.click(surface)
    unmount()
    expect(usePreviewStore.getState().minimap).toBeNull()
    expect(usePreviewStore.getState().controls).toBeNull()
    expect(screen.queryByRole('region', { name: 'Preview minimap' })).toBeNull()
  })

  it('maps portrait images, centers a fully visible axis, and ignores another file', () => {
    const { surface, rerender } = setup(600, 1600)
    const info = render(<PreviewMinimap file={file} />)
    fireEvent.click(surface)
    let map = usePreviewStore.getState().minimap!
    expect(map.aspectRatio).toBe(600 / 1600)
    expect(map.width).toBe(1)
    expect(map.x).toBe(0)
    expect(map.height).toBe(600 / 1600)
    act(() => map.panTo(1, 1))
    map = usePreviewStore.getState().minimap!
    expect(map.x).toBe(0)
    expect(map.y).toBeCloseTo(1 - map.height)
    info.rerender(<PreviewMinimap file={{ ...file, id: 'other' }} />)
    expect(screen.queryByRole('region', { name: 'Preview minimap' })).toBeNull()
    rerender(<PreviewWithControls key="b" file={{ ...file, id: 'b' }} />)
    expect(usePreviewStore.getState().minimap).toBeNull()
    expect(usePreviewStore.getState().controls).toBeNull()
  })
})

describe('image points and regions', () => {
  type Region = { x: number; y: number; width: number; height: number }
  function setupRegion() {
    const onImagePoint = vi.fn()
    const onImageRegion = vi.fn()
    const show = (outline?: Region, armed = true, selectionKey?: string): void => {
      result.rerender(
        <ZoomablePreview
          file={file}
          onImagePoint={armed ? onImagePoint : undefined}
          onImageRegion={armed ? onImageRegion : undefined}
          outline={outline}
          selectionKey={selectionKey}
        />
      )
    }
    const result = render(
      <ZoomablePreview file={file} onImagePoint={onImagePoint} onImageRegion={onImageRegion} />
    )
    // At Fit, the 1600 × 1200 image fills the 800 × 600 view at scale 0.5.
    const image = loadImage()
    const surface = screen.getByRole('region', { name: 'Image preview' })
    const media = image.parentElement!.parentElement!
    const place = (left: number, top: number, width: number, height: number): void => {
      media.getBoundingClientRect = () => ({ left, top, width, height }) as DOMRect
    }
    place(0, 0, 800, 600)
    surface.setPointerCapture = vi.fn()
    surface.hasPointerCapture = () => true
    surface.releasePointerCapture = vi.fn()
    const outline = (): SVGRectElement | null =>
      media.querySelector('[data-region-outline] rect:last-child')
    return { surface, media, place, show, outline, onImagePoint, onImageRegion }
  }
  const closeTo = (region: Region) =>
    Object.fromEntries(Object.entries(region).map(([key, value]) => [key, expect.closeTo(value)]))

  it('drags a region at Fit with a live outline inside the image, without a pan or a click', () => {
    const { surface, media, outline, onImagePoint, onImageRegion } = setupRegion()
    expect(surface.style.cursor).toBe('crosshair')
    fireEvent.pointerDown(surface, { button: 0, clientX: 80, clientY: 60 })
    expect(surface.setPointerCapture).toHaveBeenCalledWith(1)
    pointerMove(surface, { clientX: 400, clientY: 300 })
    // In image pixels, with a line of one screen pixel at scale 0.5.
    expect(Number(outline()?.getAttribute('x'))).toBeCloseTo(160)
    expect(Number(outline()?.getAttribute('y'))).toBeCloseTo(120)
    expect(Number(outline()?.getAttribute('width'))).toBeCloseTo(640)
    expect(Number(outline()?.getAttribute('height'))).toBeCloseTo(480)
    expect(outline()?.getAttribute('stroke-width')).toBe('2')
    fireEvent.pointerUp(surface)
    fireEvent.click(surface, { clientX: 400, clientY: 300, detail: 1 })
    expect(onImageRegion).toHaveBeenCalledOnce()
    expect(onImageRegion).toHaveBeenCalledWith(closeTo({ x: 0.1, y: 0.1, width: 0.4, height: 0.4 }))
    expect(onImagePoint).not.toHaveBeenCalled()
    expect(outline()).toBeNull()
    expect(media.style.transform).toBe('translate(0px, 0px) scale(0.5)')
  })

  it('reports clicks at the image edges as points, but not clicks outside it', () => {
    const { surface, media, onImagePoint, onImageRegion } = setupRegion()
    // A small movement is still a click.
    fireEvent.pointerDown(surface, { button: 0, clientX: 800, clientY: 0 })
    pointerMove(surface, { clientX: 799, clientY: 1 })
    fireEvent.pointerUp(surface)
    fireEvent.click(surface, { clientX: 800, clientY: 0, detail: 1 })
    expect(onImagePoint).toHaveBeenLastCalledWith(1, 0)
    fireEvent.click(surface, { clientX: 0, clientY: 600, detail: 1 })
    expect(onImagePoint).toHaveBeenLastCalledWith(0, 1)
    fireEvent.click(surface, { clientX: 801, clientY: 300, detail: 1 })
    fireEvent.click(surface, { clientX: 400, clientY: -1, detail: 1 })
    expect(onImagePoint).toHaveBeenCalledTimes(2)
    expect(onImageRegion).not.toHaveBeenCalled()
    expect(media.style.transform).toBe('translate(0px, 0px) scale(0.5)')
  })

  it('normalizes reverse drags, clamps them to the image, and drops cancelled drags', () => {
    const { surface, outline, onImageRegion } = setupRegion()
    fireEvent.pointerDown(surface, { button: 0, clientX: 600, clientY: 450 })
    pointerMove(surface, { clientX: -100, clientY: 150 })
    fireEvent.pointerUp(surface)
    expect(onImageRegion).toHaveBeenLastCalledWith({ x: 0, y: 0.25, width: 0.75, height: 0.5 })
    // A cancelled pointer or a lost capture reports nothing and removes the outline.
    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100 })
    pointerMove(surface, { clientX: 300, clientY: 300 })
    expect(outline()).not.toBeNull()
    fireEvent.pointerCancel(surface)
    expect(outline()).toBeNull()
    fireEvent.pointerUp(surface)
    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100 })
    pointerMove(surface, { clientX: 300, clientY: 300 })
    fireEvent.lostPointerCapture(surface)
    expect(outline()).toBeNull()
    pointerMove(surface, { clientX: 400, clientY: 400 })
    fireEvent.pointerUp(surface)
    expect(outline()).toBeNull()
    // A drag along one axis has no area.
    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100 })
    pointerMove(surface, { clientX: 300, clientY: 100 })
    fireEvent.pointerUp(surface)
    expect(onImageRegion).toHaveBeenCalledOnce()
  })

  it('selects in a zoomed and panned image instead of panning it, and pans again when disarmed', () => {
    const { surface, media, place, show, outline, onImageRegion } = setupRegion()
    fireEvent.keyDown(surface, { key: '1' })
    wheel(surface, { deltaX: 100, deltaY: 50 })
    expect(media.style.transform).toBe('translate(-100px, -50px) scale(1)')
    // The 1600 × 1200 image at scale 1, centered in the view and moved by the pan.
    place(-500, -350, 1600, 1200)
    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100 })
    pointerMove(surface, { clientX: 420, clientY: 340 })
    expect(outline()?.getAttribute('stroke-width')).toBe('1')
    fireEvent.pointerUp(surface)
    expect(onImageRegion).toHaveBeenCalledWith(
      closeTo({ x: 0.375, y: 0.375, width: 0.2, height: 0.2 })
    )
    expect(media.style.transform).toBe('translate(-100px, -50px) scale(1)')
    // The stored area stays outlined when disarmed, and a drag pans again.
    show({ x: 0.375, y: 0.375, width: 0.2, height: 0.2 }, false)
    expect(Number(outline()?.getAttribute('x'))).toBeCloseTo(600)
    expect(surface.style.cursor).toBe('grab')
    fireEvent.pointerDown(surface, { button: 0, clientX: 200, clientY: 200 })
    pointerMove(surface, { clientX: 250, clientY: 220 })
    fireEvent.pointerUp(surface)
    expect(media.style.transform).toBe('translate(-50px, -30px) scale(1)')
    expect(onImageRegion).toHaveBeenCalledOnce()
    show(undefined, false)
    expect(outline()).toBeNull()
  })

  it('selects with keys: arrows move a point, Shift sizes a rectangle, Return applies', () => {
    const { surface, outline, show, onImagePoint, onImageRegion } = setupRegion()
    // At scale 0.5, a step of 8 screen pixels is 16 image pixels: 1/100 and 1/75 of the image.
    expect(fireEvent.keyDown(surface, { key: 'ArrowRight' })).toBe(false)
    // The point starts at the center and shows as a square of 8 screen pixels.
    expect(Number(outline()?.getAttribute('x'))).toBeCloseTo(0.51 * 1600 - 8)
    expect(outline()?.getAttribute('width')).toBe('16')
    fireEvent.keyDown(surface, { key: 'Enter' })
    expect(onImagePoint).toHaveBeenCalledWith(expect.closeTo(0.51), expect.closeTo(0.5))
    expect(outline()).toBeNull()
    fireEvent.keyDown(surface, { key: 'ArrowDown' })
    fireEvent.keyDown(surface, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(surface, { key: 'ArrowRight', shiftKey: true })
    for (let i = 0; i < 3; ++i) fireEvent.keyDown(surface, { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(surface, { key: 'ArrowUp', shiftKey: true })
    expect(Number(outline()?.getAttribute('width'))).toBeCloseTo(32)
    expect(Number(outline()?.getAttribute('height'))).toBeCloseTo(32)
    fireEvent.keyDown(surface, { key: 'Enter' })
    expect(onImageRegion).toHaveBeenCalledWith(
      closeTo({ x: 0.49, y: 0.5, width: 0.02, height: 2 / 75 })
    )
    // Escape cancels a key selection. Without one, Escape and Return go to the editor.
    fireEvent.keyDown(surface, { key: 'ArrowLeft' })
    expect(fireEvent.keyDown(surface, { key: 'Escape' })).toBe(false)
    expect(outline()).toBeNull()
    expect(fireEvent.keyDown(surface, { key: 'Escape' })).toBe(true)
    expect(fireEvent.keyDown(surface, { key: 'Enter' })).toBe(true)
    expect(onImagePoint).toHaveBeenCalledOnce()
    expect(onImageRegion).toHaveBeenCalledOnce()
    // Disarmed, the arrow keys are left to other shortcuts.
    fireEvent.keyDown(surface, { key: 'ArrowLeft' })
    show(undefined, false)
    expect(outline()).toBeNull()
    expect(fireEvent.keyDown(surface, { key: 'ArrowLeft' })).toBe(true)
    expect(outline()).toBeNull()
  })

  it('lets only the pointer that started a drag end it', () => {
    const { surface, outline, onImageRegion } = setupRegion()
    fireEvent.pointerDown(surface, { button: 0, clientX: 80, clientY: 60, pointerId: 1 })
    pointerMove(surface, { clientX: 400, clientY: 300, pointerId: 1 })
    fireEvent.pointerUp(surface, { pointerId: 2 })
    fireEvent.pointerCancel(surface, { pointerId: 2 })
    fireEvent.lostPointerCapture(surface, { pointerId: 2 })
    fireEvent.pointerDown(surface, { button: 0, clientX: 0, clientY: 0, pointerId: 2 })
    pointerMove(surface, { clientX: 700, clientY: 500, pointerId: 2 })
    expect(onImageRegion).not.toHaveBeenCalled()
    expect(Number(outline()?.getAttribute('width'))).toBeCloseTo(640)
    fireEvent.pointerUp(surface, { pointerId: 1 })
    expect(onImageRegion).toHaveBeenCalledWith(closeTo({ x: 0.1, y: 0.1, width: 0.4, height: 0.4 }))
  })

  it('ends a drag or a key selection in progress when the picture changes', () => {
    const { surface, outline, show, onImagePoint, onImageRegion } = setupRegion()
    show(undefined, true, 'portrait')
    fireEvent.pointerDown(surface, { button: 0, clientX: 80, clientY: 60 })
    pointerMove(surface, { clientX: 400, clientY: 300 })
    show(undefined, true, 'landscape')
    expect(outline()).toBeNull()
    fireEvent.pointerUp(surface)
    fireEvent.click(surface, { clientX: 400, clientY: 300, detail: 1 })
    expect(onImageRegion).not.toHaveBeenCalled()
    expect(onImagePoint).not.toHaveBeenCalled()
    // The same picture keeps a key selection; another one ends it.
    fireEvent.keyDown(surface, { key: 'ArrowRight' })
    show(undefined, true, 'landscape')
    expect(outline()).not.toBeNull()
    show(undefined, true, 'portrait')
    expect(outline()).toBeNull()
    expect(fireEvent.keyDown(surface, { key: 'Enter' })).toBe(true)
    expect(onImagePoint).not.toHaveBeenCalled()
  })

  it('cancels a drag on Escape or when the mode ends, without a pan or a click', () => {
    const { surface, media, place, show, outline, onImagePoint, onImageRegion } = setupRegion()
    fireEvent.pointerDown(surface, { button: 0, clientX: 80, clientY: 60 })
    pointerMove(surface, { clientX: 400, clientY: 300 })
    expect(fireEvent.keyDown(surface, { key: 'Escape' })).toBe(false)
    expect(outline()).toBeNull()
    pointerMove(surface, { clientX: 500, clientY: 400 })
    expect(outline()).toBeNull()
    fireEvent.pointerUp(surface)
    fireEvent.click(surface, { clientX: 500, clientY: 400, detail: 1 })
    expect(onImageRegion).not.toHaveBeenCalled()
    expect(onImagePoint).not.toHaveBeenCalled()
    // The mode ends during a drag, as when W arms the white balance picker. Zoomed in,
    // a drag that stayed active would pan, and the click after it would zoom out.
    fireEvent.keyDown(surface, { key: '1' })
    place(-400, -300, 1600, 1200)
    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 100 })
    pointerMove(surface, { clientX: 300, clientY: 300 })
    expect(outline()).not.toBeNull()
    show(undefined, false)
    expect(outline()).toBeNull()
    pointerMove(surface, { clientX: 350, clientY: 350 })
    fireEvent.pointerUp(surface)
    fireEvent.click(surface, { clientX: 350, clientY: 350, detail: 1 })
    expect(media.style.transform).toBe('translate(0px, 0px) scale(1)')
    expect(onImageRegion).not.toHaveBeenCalled()
  })
})

describe('editor viewport tiles', () => {
  it('publishes the viewport for a new picture at once and for a moving view when it rests', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onViewportChange = vi.fn()
    const onViewportMove = vi.fn()
    const preview = (
      url?: string,
      naturalSize = { width: 6000, height: 4000 }
    ): React.JSX.Element => (
      <ZoomablePreview
        file={url ? { ...file, displayPreviewUrl: url } : file}
        naturalSize={naturalSize}
        onViewportChange={onViewportChange}
        onViewportMove={onViewportMove}
      />
    )
    const result = render(preview())
    loadImage(512, 341)
    const media = document.querySelector<HTMLElement>('.preview-image')!
    expect(media.style.width).toBe('6000px')
    expect(onViewportChange).toHaveBeenCalledOnce()
    expect(onViewportChange).toHaveBeenLastCalledWith(null)
    // An eased zoom goes to the renderer after its animation.
    act(() => usePreviewStore.getState().controls!.zoomTo(1))
    act(() => vi.advanceTimersByTime(259))
    expect(onViewportChange).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(1))
    const area = onViewportChange.mock.lastCall![0]
    expect(area.width).toBeCloseTo(800 / 6000)
    expect(area.height).toBeCloseTo(600 / 4000)
    // A gesture sends one region, after the view rests.
    const surface = screen.getByRole('region', { name: 'Image preview' })
    onViewportMove.mockClear()
    for (let step = 0; step < 5; step++) {
      wheel(surface, { deltaX: 20, deltaY: 0 })
      act(() => vi.advanceTimersByTime(100))
    }
    expect(onViewportMove).toHaveBeenCalledTimes(5)
    expect(onViewportChange).toHaveBeenCalledTimes(2)
    act(() => vi.advanceTimersByTime(20))
    expect(onViewportChange).toHaveBeenCalledTimes(3)
    const moved = onViewportChange.mock.lastCall![0]
    expect(moved.x).toBeGreaterThan(area.x)
    expect(moved.width).toBe(area.width)
    // A new picture, as after a geometry change, gets the region before paint
    // and replaces a region that waits for rest.
    wheel(surface, { deltaX: -20, deltaY: 0 })
    result.rerender(preview('new-geometry-base'))
    expect(onViewportChange).toHaveBeenCalledTimes(4)
    expect(onViewportChange.mock.lastCall![0].x).toBeCloseTo(moved.x - 20 / 6000)
    act(() => vi.advanceTimersByTime(500))
    expect(onViewportChange).toHaveBeenCalledTimes(4)
    // A rotated picture brings its dimensions in the same render as its URL.
    result.rerender(preview('rotated-base', { width: 4000, height: 6000 }))
    expect(onViewportChange).toHaveBeenCalledTimes(5)
    expect(onViewportChange.mock.lastCall![0].width).toBeCloseTo(800 / 4000)
    expect(onViewportChange.mock.lastCall![0].height).toBeCloseTo(600 / 6000)
    act(() => vi.advanceTimersByTime(500))
    expect(onViewportChange).toHaveBeenCalledTimes(5)
    act(() => usePreviewStore.getState().controls!.zoomTo(null))
    act(() => vi.advanceTimersByTime(260))
    expect(onViewportChange).toHaveBeenCalledTimes(6)
    expect(onViewportChange).toHaveBeenLastCalledWith(null)
    expect(usePreviewStore.getState().minimap).toBeNull()
    // A view that unmounts before it rests sends nothing.
    act(() => usePreviewStore.getState().controls!.zoomTo(1))
    result.unmount()
    act(() => vi.advanceTimersByTime(500))
    expect(onViewportChange).toHaveBeenCalledTimes(6)
  })

  it('retains decoded native pixels at their image coordinates through pans and replacement decoding', async () => {
    const pending = holdFrames()
    const draw = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: draw
    } as unknown as CanvasRenderingContext2D)
    const result = render(<ZoomablePreview file={file} />)
    loadImage()
    act(() => usePreviewStore.getState().controls!.zoomTo(1))
    const { x, y, width, height } = usePreviewStore.getState().minimap!
    const viewport = { x, y, width, height }
    const first = { url: 'tile-1', region: { ...viewport, x: x + 0.0001 }, viewport }
    result.rerender(<ZoomablePreview file={file} tile={first} />)
    const canvas = result.container.querySelector<HTMLCanvasElement>('[data-editor-tile]')!
    expect(canvas.dataset.previewUrl).toBeUndefined()
    await act(async () => pending[0].finish())
    expect(canvas.dataset.previewUrl).toBe('tile-1')
    expect(canvas.style.left).toBe(`${first.region.x * 100}%`)
    expect(draw).toHaveBeenCalledWith(pending[0].frame.image, 0, 0)
    expect(pending[0].frame.release).toHaveBeenCalledOnce()
    result.rerender(<ZoomablePreview file={file} tile={{ ...first, url: 'tile-2' }} />)
    expect(result.container.querySelector('[data-editor-tile]')).toBe(canvas)
    expect(canvas.dataset.previewUrl).toBe('tile-1')
    result.rerender(<ZoomablePreview file={file} tile={{ ...first, url: 'tile-3' }} />)
    // A replaced tile cancels its load; late pixels are released, not drawn.
    expect(pending[1].signal.aborted).toBe(true)
    await act(async () => pending[1].finish())
    expect(canvas.dataset.previewUrl).toBe('tile-1')
    expect(pending[1].frame.release).toHaveBeenCalledOnce()
    await act(async () => pending[2].finish())
    expect(canvas.dataset.previewUrl).toBe('tile-3')
    const previousPlacement = canvas.style.cssText
    const previousDrawCount = draw.mock.calls.length
    wheel(screen.getByRole('region', { name: 'Image preview' }), { deltaX: 100 })
    expect(result.container.querySelector('[data-editor-tile]')).toBe(canvas)
    expect(canvas.dataset.previewUrl).toBe('tile-3')
    expect(canvas.style.cssText).toBe(previousPlacement)
    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(600)
    expect(draw).toHaveBeenCalledTimes(previousDrawCount)
    const moved = usePreviewStore.getState().minimap!
    const nextViewport = { x: moved.x, y: moved.y, width: moved.width, height: moved.height }
    const next = {
      url: 'tile-4',
      region: { ...nextViewport, x: nextViewport.x + 0.0001 },
      viewport: nextViewport
    }
    result.rerender(<ZoomablePreview file={file} tile={next} />)
    expect(result.container.querySelector('[data-editor-tile]')).toBe(canvas)
    expect(canvas.dataset.previewUrl).toBe('tile-3')
    expect(canvas.style.cssText).toBe(previousPlacement)
    await act(async () => pending[3].finish())
    expect(canvas.dataset.previewUrl).toBe('tile-4')
    expect(canvas.style.left).toBe(`${next.region.x * 100}%`)
    expect(canvas.style.cssText).not.toBe(previousPlacement)
    act(() => usePreviewStore.getState().controls!.zoomTo(null))
    expect(result.container.querySelector('[data-editor-tile]')).toBeNull()
  })

  it('paints cached renders over the tile at native pixels, clears for a new recipe and reports misses', async () => {
    const pending = holdFrames()
    const draw = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: draw
    } as unknown as CanvasRenderingContext2D)
    const miss = vi.fn()
    const size = { width: 1600, height: 1200 }
    const region = (x: number, y: number) => ({
      x: x / 1600,
      y: y / 1200,
      width: 0.25,
      height: 0.25
    })
    const cache = {
      key: 'one',
      ...size,
      renders: [{ url: 'block-1', region: region(400, 300) }]
    }
    const result = render(
      <ZoomablePreview file={file} naturalSize={size} cache={cache} onCacheMiss={miss} />
    )
    loadImage()
    // Fit shows no cache layer; it needs a zoomed view.
    expect(result.container.querySelector('[data-editor-cache]')).toBeNull()
    act(() => usePreviewStore.getState().controls!.zoomTo(1))
    const layer = result.container.querySelector<HTMLCanvasElement>('[data-editor-cache]')!
    expect([layer.width, layer.height]).toEqual([1600, 1200])
    result.rerender(
      <ZoomablePreview
        file={file}
        naturalSize={size}
        tile={{ url: 'tile', region: region(0, 0), viewport: region(0, 0) }}
        cache={cache}
        onCacheMiss={miss}
      />
    )
    // The cache goes over the tile, which can hold an older recipe.
    const tile = result.container.querySelector('[data-editor-tile]')!
    expect(tile.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const block = pending.find(({ url }) => url === 'block-1')!
    await act(async () => block.finish())
    expect(draw).toHaveBeenCalledWith(block.frame.image, 400, 300)
    // A new render of the same recipe adds to the canvas; nothing is painted twice.
    const more = { ...cache, renders: [...cache.renders, { url: 'block-2', region: region(0, 0) }] }
    result.rerender(
      <ZoomablePreview file={file} naturalSize={size} cache={more} onCacheMiss={miss} />
    )
    const second = pending.find(({ url }) => url === 'block-2')!
    await act(async () => second.fail())
    expect(miss).toHaveBeenCalledWith('block-2')
    expect(pending.filter(({ url }) => url === 'block-1')).toHaveLength(1)
    // The store drops the miss; a later render of the same URL loads again.
    result.rerender(
      <ZoomablePreview file={file} naturalSize={size} cache={cache} onCacheMiss={miss} />
    )
    result.rerender(
      <ZoomablePreview file={file} naturalSize={size} cache={{ ...more }} onCacheMiss={miss} />
    )
    expect(pending.filter(({ url }) => url === 'block-2')).toHaveLength(2)
    const late = { ...more, renders: [...more.renders, { url: 'block-4', region: region(0, 0) }] }
    result.rerender(
      <ZoomablePreview file={file} naturalSize={size} cache={late} onCacheMiss={miss} />
    )
    const old = pending.find(({ url }) => url === 'block-4')!
    // A new recipe clears the canvas and ignores decodes for the old one.
    const next = { key: 'two', ...size, renders: [{ url: 'block-3', region: region(800, 600) }] }
    result.rerender(
      <ZoomablePreview file={file} naturalSize={size} cache={next} onCacheMiss={miss} />
    )
    expect(layer.width).toBe(1600)
    const third = pending.find(({ url }) => url === 'block-3')!
    draw.mockClear()
    expect(old.signal.aborted).toBe(true)
    await act(async () => old.finish())
    await act(async () => third.finish())
    expect(draw).toHaveBeenCalledTimes(1)
    expect(draw).toHaveBeenCalledWith(third.frame.image, 800, 600)
    expect(old.frame.release).toHaveBeenCalledOnce()
    expect(third.frame.release).toHaveBeenCalledOnce()
    act(() => usePreviewStore.getState().controls!.zoomTo(null))
    expect(result.container.querySelector('[data-editor-cache]')).toBeNull()
    expect([layer.width, layer.height]).toEqual([0, 0])
  })

  it('loads at most four cached renders at a time and drops the queue for a new recipe', async () => {
    const pending = holdFrames()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn()
    } as unknown as CanvasRenderingContext2D)
    const size = { width: 1600, height: 1200 }
    const region = { x: 0, y: 0, width: 0.25, height: 0.25 }
    const renders = [1, 2, 3, 4, 5, 6].map((i) => ({ url: `block-${i}`, region }))
    const cache = { key: 'one', ...size, renders }
    const result = render(<ZoomablePreview file={file} naturalSize={size} cache={cache} />)
    loadImage()
    act(() => usePreviewStore.getState().controls!.zoomTo(1))
    expect(pending.map(({ url }) => url)).toEqual(['block-1', 'block-2', 'block-3', 'block-4'])
    await act(async () => pending[0].finish())
    expect(pending.map(({ url }) => url)).toEqual([
      'block-1',
      'block-2',
      'block-3',
      'block-4',
      'block-5'
    ])
    const next = { key: 'two', ...size, renders: [{ url: 'block-7', region }] }
    result.rerender(<ZoomablePreview file={file} naturalSize={size} cache={next} />)
    expect(pending.slice(1, 5).every(({ signal }) => signal.aborted)).toBe(true)
    await act(async () => pending.slice(1, 5).forEach(({ finish }) => finish()))
    expect(pending.map(({ url }) => url).slice(5)).toEqual(['block-7'])
  })
})
