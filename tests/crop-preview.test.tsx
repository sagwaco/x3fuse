// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { defaultRecipe, type EditRecipe, type RenderedPreview } from '@shared/editor'
import { CropPreview } from '../src/renderer/src/components/CropPreview'
import { appInfo } from '../src/renderer/src/lib/appInfo'
import type { Rect } from '../src/renderer/src/lib/cropGeometry'

const store = vi.hoisted(() => ({ change: vi.fn(), commit: vi.fn() }))
vi.mock('../src/renderer/src/stores/editorStore', () => ({
  useEditorStore: (select: (state: typeof store) => unknown) => select(store)
}))

const W = 1200
const H = 800
const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
let recipe: EditRecipe
let replacePreview: (factor: number) => void

function Canvas({
  initialCrop = crop,
  rotation = 0,
  locked = false
}: {
  initialCrop?: Rect | null
  rotation?: number
  locked?: boolean
}) {
  const [current, setRecipe] = useState({ ...defaultRecipe(), crop: initialCrop, rotation })
  const [preview, setPreview] = useState<RenderedPreview>({
    sessionId: 'crop',
    revision: 0,
    url: 'preview',
    width: W,
    height: H,
    sourceWidth: 6000,
    sourceHeight: 4000
  })
  recipe = current
  store.change.mockImplementation((patch: Partial<EditRecipe>) =>
    setRecipe((value) => ({ ...value, ...patch }))
  )
  replacePreview = (factor) =>
    setPreview((value) => ({
      ...value,
      url: `${value.url}:refined`,
      revision: value.revision + 1,
      width: value.width * factor,
      height: value.height * factor
    }))
  return <CropPreview preview={preview} recipe={current} locked={locked} onDone={() => {}} />
}

beforeEach(() => {
  store.change.mockReset()
  store.commit.mockReset()
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      decode = () => new Promise<void>(() => {})
    }
  )
  vi.stubGlobal(
    'DOMPoint',
    class {
      constructor(
        public x: number,
        public y: number
      ) {}
      matrixTransform(matrix: { transformPoint: (point: { x: number; y: number }) => unknown }) {
        return matrix.transformPoint(this)
      }
    }
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function canvas(props: Parameters<typeof Canvas>[0] = {}): SVGSVGElement {
  const view = render(<Canvas {...props} />)
  const svg = view.container.querySelector('svg')!
  const layer = svg.querySelector('g')!
  Object.defineProperty(svg, 'setPointerCapture', { value: vi.fn() })
  // Keep screen pixels fixed while the SVG coordinate space changes.
  Object.defineProperty(layer, 'getScreenCTM', {
    value: () => {
      const [, , width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number)
      const turned = recipe.rotation % 2 !== 0
      const w = (turned ? height : width) - 2 * (Math.max(width, height) / 1.16) * 0.08
      const h = (turned ? width : height) - 2 * (Math.max(width, height) / 1.16) * 0.08
      return {
        inverse: () => ({
          transformPoint: (point: { x: number; y: number }) => {
            const [x, y] = [
              [point.x, point.y],
              [point.y, H - point.x],
              [W - point.x, H - point.y],
              [W - point.y, point.x]
            ][recipe.rotation]
            return { x: (x * w) / W, y: (y * h) / H }
          }
        })
      }
    }
  })
  return svg
}

function pointer(
  svg: SVGSVGElement,
  type: 'Down' | 'Move' | 'Up',
  x: number,
  y: number,
  altKey = false
) {
  const [clientX, clientY] = [
    [x, y],
    [H - y, x],
    [W - x, H - y],
    [y, W - x]
  ][recipe.rotation]
  fireEvent[`pointer${type}`](svg, {
    clientX,
    clientY,
    button: 0,
    buttons: type === 'Up' ? 0 : 1,
    altKey
  })
}

it.each([0, 1, 2, 3])('uses Alt during a resize at quarter turn %s', (rotation) => {
  const svg = canvas({ rotation })
  pointer(svg, 'Down', 900, 600)
  pointer(svg, 'Move', 960, 640, true)
  expect(recipe.crop).toEqual({ x: 0.2, y: 0.2, width: 0.6, height: 0.6 })
  pointer(svg, 'Move', 960, 640)
  expect(recipe.crop).toEqual({ x: 0.25, y: 0.25, width: 0.55, height: 0.55 })
  pointer(svg, 'Move', W * 2, H * 2, true)
  expect(recipe.crop!.x).toBeCloseTo(0)
  expect(recipe.crop!.y).toBeCloseTo(0)
  expect(recipe.crop!.width).toBeCloseTo(1)
  expect(recipe.crop!.height).toBeCloseTo(1)
  pointer(svg, 'Up', W * 2, H * 2, true)
  expect(store.commit).toHaveBeenCalledOnce()
})

it('keeps the locked ratio and center when Alt-dragging a side handle', () => {
  const svg = canvas({ locked: true })
  pointer(svg, 'Down', 300, 400, true)
  pointer(svg, 'Move', 240, 400, true)
  expect(recipe.crop).toEqual({ x: 0.2, y: 0.2, width: 0.6, height: 0.6 })
  pointer(svg, 'Up', 240, 400, true)
  expect(store.commit).toHaveBeenCalledOnce()
})

it('keeps the opposite corner fixed when Control is held', () => {
  const svg = canvas()
  pointer(svg, 'Down', 900, 600)
  fireEvent.pointerMove(svg, { clientX: 960, clientY: 640, buttons: 1, ctrlKey: true })
  expect(recipe.crop).toEqual({ x: 0.25, y: 0.25, width: 0.55, height: 0.55 })
  pointer(svg, 'Up', 960, 640)
  expect(store.commit).toHaveBeenCalledOnce()
})

it.each([false, true])('draws a crop about the pointer with Alt and lock %s', (locked) => {
  const svg = canvas({ initialCrop: null, locked })
  pointer(svg, 'Down', 600, 400, true)
  pointer(svg, 'Move', 900, 600, true)
  expect(recipe.crop).toEqual(crop)
  pointer(svg, 'Up', 900, 600, true)
  expect(store.commit).toHaveBeenCalledOnce()
})

it('draws a free crop inside a full frame and stops at the image bounds', () => {
  const svg = canvas({ initialCrop: null })
  pointer(svg, 'Down', 600, 400)
  pointer(svg, 'Move', 900, 400)
  expect(store.change).not.toHaveBeenCalled()
  pointer(svg, 'Move', 900, 600)
  expect(recipe.crop).toEqual({ x: 0.5, y: 0.5, width: 0.25, height: 0.25 })
  pointer(svg, 'Move', W * 2, H * 2)
  expect(recipe.crop!.x + recipe.crop!.width).toBeCloseTo(1)
  expect(recipe.crop!.y + recipe.crop!.height).toBeCloseTo(1)
  pointer(svg, 'Move', 300, 200)
  expect(recipe.crop).toEqual({ x: 0.25, y: 0.25, width: 0.25, height: 0.25 })
  expect(store.commit).not.toHaveBeenCalled()
  pointer(svg, 'Up', 300, 200)
  expect(store.commit).toHaveBeenCalledOnce()
})

it('keeps the aspect ratio when drawing a locked crop', () => {
  const svg = canvas({ initialCrop: null, locked: true })
  pointer(svg, 'Down', 600, 400)
  pointer(svg, 'Move', 900, 450)
  expect(recipe.crop).toEqual({ x: 0.5, y: 0.5, width: 0.25, height: 0.25 })
  pointer(svg, 'Up', 900, 450)
  expect(store.commit).toHaveBeenCalledOnce()
})

it.each([0.5, 2])(
  'keeps move and resize drags active when preview size changes by %s',
  (factor) => {
    for (const handle of ['move', 'nw']) {
      const svg = canvas()
      const [x, y] = handle === 'move' ? [600, 400] : [300, 200]
      pointer(svg, 'Down', x, y)
      pointer(svg, 'Move', x - 30, y - 30)
      act(() => replacePreview(factor))
      pointer(svg, 'Move', x - 60, y - 60)
      expect(recipe.crop!.x).toBeCloseTo(0.2)
      expect(recipe.crop!.y).toBeCloseTo(0.175)
      expect(recipe.crop!.width).toBeCloseTo(handle === 'move' ? 0.5 : 0.55)
      expect(recipe.crop!.height).toBeCloseTo(handle === 'move' ? 0.5 : 0.575)
      expect(store.commit).not.toHaveBeenCalled()
      pointer(svg, 'Up', x - 60, y - 60)
      expect(store.commit).toHaveBeenCalledOnce()
      cleanup()
      store.commit.mockClear()
    }
  }
)

it.each([0, 1, 2, 3])(
  'rotates from every corner after preview replacement at quarter turn %s',
  (rotation) => {
    for (const [x, y] of [
      [-24, -24],
      [W + 24, -24],
      [W + 24, H + 24],
      [-24, H + 24]
    ]) {
      const svg = canvas({ initialCrop: null, rotation })
      pointer(svg, 'Down', x, y)
      act(() => replacePreview(0.5))
      const radians = (5 * Math.PI) / 180
      const dx = x - W / 2
      const dy = y - H / 2
      pointer(
        svg,
        'Move',
        W / 2 + Math.cos(radians) * dx - Math.sin(radians) * dy,
        H / 2 + Math.sin(radians) * dx + Math.cos(radians) * dy
      )
      expect(recipe.straighten).toBeCloseTo(5)
      pointer(svg, 'Up', x, y)
      cleanup()
    }
  }
)

it('turns the resize and rotate cursors with the side under the pointer', () => {
  const cursor = (rotation: number, x: number, y: number): string => {
    const svg = canvas({ rotation })
    pointer(svg, 'Move', x, y)
    const value = decodeURIComponent(svg.style.cursor)
    cleanup()
    return value
  }
  expect(cursor(0, 600, 200)).toBe('ns-resize')
  expect(cursor(1, 600, 200)).toBe('ew-resize')
  expect(cursor(0, 900, 600)).toBe('nwse-resize')
  expect(cursor(1, 900, 600)).toBe('nesw-resize')
  expect(cursor(0, 600, 170)).toContain('rotate(0 12 12)')
  expect(cursor(0, 920, 170)).toContain('rotate(45 12 12)')
  expect(cursor(1, 600, 170)).toContain('rotate(90 12 12)')
  expect(cursor(0, 280, 620)).toContain('rotate(225 12 12)')
})

it('uses the macOS cursor of the side under the pointer', () => {
  appInfo.platform = 'darwin'
  const cursor = (rotation: number, x: number, y: number): string => {
    const svg = canvas({ rotation })
    pointer(svg, 'Move', x, y)
    const value = svg.style.cursor
    cleanup()
    return value
  }
  try {
    expect(cursor(0, 600, 170)).toContain('rotate-n@2x.png')
    expect(cursor(0, 920, 170)).toContain('rotate-ne@2x.png')
    expect(cursor(0, 280, 620)).toContain('rotate-sw@2x.png')
    expect(cursor(1, 600, 170)).toContain('rotate-e@2x.png')
    expect(cursor(0, 600, 200)).toBe('ns-resize')
  } finally {
    appInfo.platform = 'linux'
  }
})
