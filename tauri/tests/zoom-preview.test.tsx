// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { X3FFileDTO } from '@shared/types'
import { ZoomablePreview } from '../src/renderer/src/components/ZoomablePreview'
import { ZoomControls } from '../src/renderer/src/components/ZoomControls'
import { PreviewMinimap } from '../src/renderer/src/components/PreviewMinimap'
import { usePreviewStore } from '../src/renderer/src/stores/previewStore'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))

const file: X3FFileDTO = {
  id: 'a',
  path: '/photos/a.X3F',
  fileName: 'a.X3F'
}
let resize: (width: number, height: number) => void

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(null)
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function loadImage(width = 1600, height = 1200): HTMLImageElement {
  const image = document.querySelector('img[src$="v=full"]') as HTMLImageElement
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
    fireEvent.wheel(surface, { deltaX: 20, deltaY: 10 })
    expect(media.dataset.zoomAnimated).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(media.dataset.zoomAnimated).toBe('true')
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: 10 })
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
    fireEvent.wheel(surface, { deltaX: 10, deltaY: 5 })
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
    expect(pinch.defaultPrevented).toBe(true)
    expect(media.style.transform).toContain('scale(1)')
    expect(media.style.transform).toContain('translate(-200px, -100px)')
    fireEvent.wheel(surface, { deltaX: 50, deltaY: 80 })
    expect(media.style.transform).toContain('translate(-250px, -180px)')
    fireEvent.wheel(surface, { deltaX: 10000, deltaY: 10000 })
    expect(media.style.transform).toContain('translate(-400px, -300px)')
    fireEvent.wheel(surface, { deltaX: -10000, deltaY: -10000 })
    expect(media.style.transform).toContain('translate(400px, 300px)')
    fireEvent.click(surface)
    expect(media.style.transform).toContain('translate(0px, 0px)')
    fireEvent.wheel(surface, { deltaX: 50, deltaY: 50 })
    expect(media.style.transform).toContain('translate(0px, 0px)')
  })

  it('captures a primary drag and stops panning on release or cancellation', () => {
    const { surface, media } = setup()
    fireEvent.click(surface)
    fireEvent.pointerDown(surface, { button: 0, clientX: 200, clientY: 200 })
    expect(surface.setPointerCapture).toHaveBeenCalledWith(1)
    fireEvent.pointerMove(surface, { clientX: 300, clientY: 250 })
    expect(media.style.transform).toContain('translate(100px, 50px)')
    fireEvent.pointerUp(surface)
    expect(surface.releasePointerCapture).toHaveBeenCalledWith(1)
    fireEvent.click(surface)
    expect(media.style.transform).toContain('scale(1)')
    fireEvent.pointerMove(surface, { clientX: 500, clientY: 500 })
    expect(media.style.transform).toContain('translate(100px, 50px)')
    fireEvent.pointerDown(surface, { button: 0 })
    fireEvent.pointerCancel(surface)
    fireEvent.pointerMove(surface, { clientX: 500, clientY: 500 })
    expect(media.style.transform).toContain('translate(100px, 50px)')
    fireEvent.pointerDown(surface, { button: 2 })
    fireEvent.pointerMove(surface, { clientX: 500, clientY: 500 })
    expect(media.style.transform).toContain('translate(100px, 50px)')
  })

  it('recomputes Fit on resize and resets it when a different file is selected', () => {
    const { surface, media, rerender } = setup(1200, 1600)
    expect(media.style.transform).toContain('scale(0.375)')
    act(() => resize(400, 300))
    expect(media.style.transform).toContain('scale(0.1875)')
    fireEvent.click(surface)
    expect(media.style.transform).toContain('scale(1)')
    fireEvent.wheel(surface, { deltaX: 500, deltaY: 500 })
    act(() => resize(2000, 2000))
    expect(media.style.transform).toContain('translate(0px, 0px)')
    act(() => resize(400, 300))
    expect(media.style.transform).toContain('translate(0px, 0px)')
    rerender(<PreviewWithControls key="b" file={{ ...file, id: 'b', path: '/photos/b.X3F' }} />)
    loadImage()
    expect(screen.getByRole('button', { name: 'Zoom level' }).textContent).toBe('Fit')
  })

  it('supports keyboard zoom and bounds extreme gestures', () => {
    const { surface, media } = setup()
    fireEvent.keyDown(surface, { key: '1' })
    expect(media.style.transform).toContain('scale(1)')
    fireEvent.keyDown(surface, { key: '+' })
    expect(media.style.transform).toContain('scale(1.25)')
    fireEvent.keyDown(surface, { key: '-' })
    expect(media.style.transform).toContain('scale(1)')
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: -100000 })
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(media.style.transform).toContain('scale(8)')
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: 100000 })
    expect((screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(media.style.transform).toContain('scale(0.1)')
    fireEvent.keyDown(surface, { key: '0' })
    expect(screen.getByRole('button', { name: 'Zoom level' }).textContent).toBe('Fit')
  })

  it('disables controls until a preview loads, including pending and failed previews', () => {
    const result = render(<PreviewWithControls key="pending" file={{ ...file, pending: true }} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(document.querySelector('img[src$="v=full"]')?.getAttribute('loading')).toBe('eager')
    expect(
      screen.getAllByRole('button').every((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true)
    result.rerender(<PreviewWithControls key="failed" file={file} />)
    // A usable small image never enables full-resolution zoom controls.
    fireEvent.error(document.querySelector('img[src$="v=full"]')!)
    fireEvent.load(screen.getByRole('img'))
    expect(screen.getByRole('img').getAttribute('src')).toContain('v=preview')
    expect(
      screen.getAllByRole('button').every((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true)
  })

  it('enables full-image zoom before metadata arrives and keeps it ready afterward', () => {
    const result = render(<PreviewWithControls file={{ ...file, pending: true }} />)
    loadImage()
    expect(usePreviewStore.getState().controls?.fileId).toBe(file.id)
    result.rerender(
      <PreviewWithControls file={{ ...file, pending: false, orientation: 6, aspectRatio: 1 }} />
    )
    expect(usePreviewStore.getState().controls?.fileId).toBe(file.id)
    expect(document.querySelector('.rt-Skeleton')).toBeNull()
    expect(screen.getByRole('img').getAttribute('src')).toContain('v=full')
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
    fireEvent.pointerMove(minimap, { clientX: 90, clientY: 75 })
    expect(parseFloat(rectangle.style.left)).toBeCloseTo(35)
    expect(parseFloat(rectangle.style.top)).toBeCloseTo(35)
    expect(usePreviewStore.getState().minimap!.x).toBeCloseTo(0.35)
    fireEvent.pointerUp(minimap)
    fireEvent.pointerMove(minimap, { clientX: 200, clientY: 150 })
    expect(parseFloat(rectangle.style.left)).toBeCloseTo(35)
    expect(media.style.transform).toContain('scale(1)')

    // Clicking outside recenters, with both the image and map clamped at the edge.
    fireEvent.pointerDown(minimap, { button: 0, clientX: 199, clientY: 149 })
    expect(rectangle.style.left).toBe('50%')
    expect(rectangle.style.top).toBe('50%')
    expect(media.style.transform).toContain('translate(-400px, -300px)')
    fireEvent.pointerCancel(minimap)
    fireEvent.pointerMove(minimap, { clientX: 0, clientY: 0 })
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
