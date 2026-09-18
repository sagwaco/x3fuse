// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { X3FFileDTO } from '@shared/types'
import { ZoomablePreview } from '../src/renderer/src/components/ZoomablePreview'
import { ZoomControls } from '../src/renderer/src/components/ZoomControls'
import { PreviewMinimap } from '../src/renderer/src/components/PreviewMinimap'
import { usePreviewStore } from '../src/renderer/src/stores/previewStore'

const file: X3FFileDTO = {
  id: 'a',
  path: '/photos/a.X3F',
  fileName: 'a.X3F'
}
let resize: (width: number, height: number) => void

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = (width, height) =>
          callback(
            [{ contentRect: { width, height } } as ResizeObserverEntry],
            this as unknown as ResizeObserver
          )
      }
      observe(): void {
        resize(800, 600)
      }
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
})

function loadImage(width = 1600, height = 1200): HTMLImageElement {
  const image = screen.getByRole('img') as HTMLImageElement
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

describe('filmstrip zoom preview', () => {
  it('steps from below Fit to Fit to 100%, and returns any zoom at or above 100% to Fit', () => {
    const { surface, media } = setup()
    const dropdown = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(dropdown, { target: { value: '25' } })
    fireEvent.click(surface)
    expect(dropdown.value).toBe('fit')
    expect(media.style.width).toBe('800px')
    fireEvent.click(surface)
    expect(dropdown.value).toBe('100')
    fireEvent.click(surface)
    expect(dropdown.value).toBe('fit')

    // Numeric Fit and intermediate zoom levels also advance to 100%.
    for (const value of ['50', '75']) {
      fireEvent.change(dropdown, { target: { value } })
      fireEvent.click(surface)
      expect(dropdown.value).toBe('100')
    }
    for (const value of ['100', '125', '200']) {
      fireEvent.change(dropdown, { target: { value } })
      fireEvent.click(surface)
      expect(dropdown.value).toBe('fit')
    }
  })

  it('returns to Fit when the image fits at its natural size', () => {
    const { surface } = setup(400, 300)
    const dropdown = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(dropdown, { target: { value: '50' } })
    fireEvent.click(surface)
    expect(dropdown.value).toBe('fit')
    fireEvent.change(dropdown, { target: { value: '200' } })
    fireEvent.click(surface)
    expect(dropdown.value).toBe('fit')
  })

  it('fits the JPEG, toggles true 100%, and keeps toolbar controls separate from gestures', () => {
    const { surface, media } = setup()
    expect(media.style.width).toBe('800px')
    expect(surface.style.cursor).toBe('zoom-in')
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Zoom out', 'Zoom in'])
    expect(
      Array.from((screen.getByRole('combobox') as HTMLSelectElement).options).map(
        (option) => option.value
      )
    ).toEqual(['fit', '25', '50', '75', '100', '125', '150', '175', '200'])
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('fit')
    fireEvent.click(surface)
    expect(media.style.width).toBe('1600px')
    expect(surface.style.cursor).toBe('grab')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('100')
    fireEvent.click(surface)
    expect(media.style.width).toBe('800px')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(media.style.width).toBe('1000px')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(media.style.width).toBe('800px')
    fireEvent.doubleClick(screen.getByRole('group'))
    expect(media.style.width).toBe('800px')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '100' } })
    expect(media.style.width).toBe('1600px')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fit' } })
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('fit')
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
    expect(media.style.width).toBe('1600px')
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
    expect(media.style.width).toBe('1600px')
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
    expect(media.style.height).toBe('600px')
    expect(media.style.width).toBe('450px')
    act(() => resize(400, 300))
    expect(media.style.height).toBe('300px')
    fireEvent.click(surface)
    expect(media.style.width).toBe('1200px')
    fireEvent.wheel(surface, { deltaX: 500, deltaY: 500 })
    act(() => resize(2000, 2000))
    expect(media.style.transform).toContain('translate(0px, 0px)')
    act(() => resize(400, 300))
    expect(media.style.transform).toContain('translate(0px, 0px)')
    rerender(<PreviewWithControls key="b" file={{ ...file, id: 'b', path: '/photos/b.X3F' }} />)
    loadImage()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('fit')
  })

  it('supports keyboard zoom and bounds extreme gestures', () => {
    const { surface, media } = setup()
    fireEvent.keyDown(surface, { key: '1' })
    expect(media.style.width).toBe('1600px')
    fireEvent.keyDown(surface, { key: '+' })
    expect(media.style.width).toBe('2000px')
    fireEvent.keyDown(surface, { key: '-' })
    expect(media.style.width).toBe('1600px')
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: -100000 })
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(media.style.width).toBe('12800px')
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: 100000 })
    expect((screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(media.style.width).toBe('160px')
    fireEvent.keyDown(surface, { key: '0' })
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('fit')
  })

  it('disables controls until a preview loads, including pending and failed previews', () => {
    const result = render(<PreviewWithControls key="pending" file={{ ...file, pending: true }} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(
      screen.getAllByRole('button').every((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true)
    result.rerender(<PreviewWithControls key="failed" file={file} />)
    fireEvent.error(screen.getByRole('img'))
    expect(
      screen.getAllByRole('button').every((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true)
  })

  it('offers each zoom preset and preserves the current percentage after gesture zoom', () => {
    const { media } = setup()
    const select = screen.getByRole('combobox') as HTMLSelectElement
    for (const percent of [25, 50, 75, 100, 125, 150, 175, 200]) {
      fireEvent.change(select, { target: { value: String(percent) } })
      expect(media.style.width).toBe(`${(1600 * percent) / 100}px`)
    }
    fireEvent.change(select, { target: { value: 'fit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(select.selectedOptions[0].text).toBe('63%')
    expect(select.selectedOptions[0].disabled).toBe(true)
    const queueNavigation = vi.fn()
    // Dropdown keys must not reach the filmstrip's queue navigation.
    document.addEventListener('keydown', queueNavigation)
    fireEvent.keyDown(select, { key: 'ArrowDown' })
    expect(queueNavigation).not.toHaveBeenCalled()
    document.removeEventListener('keydown', queueNavigation)
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
    expect(media.style.width).toBe('1600px')

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
