// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'
import type { PreviewRegion } from '@shared/editor'
import { Inspector } from '../src/renderer/src/components/Inspector'
import { FileFilmstrip } from '../src/renderer/src/components/FileFilmstrip'
import { qualifySquare } from '../src/renderer/src/lib/qualifySquare'
import { useQueueStore } from '../src/renderer/src/stores/queueStore'
import { useScopeSourceStore } from '../src/renderer/src/stores/scopeSourceStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'

const { zoom, scope } = vi.hoisted(() => ({
  zoom: { current: {} as Record<string, unknown> },
  scope: { current: {} as Record<string, unknown> }
}))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke: vi.fn(async () => []) } }))
vi.mock('../src/renderer/src/components/Thumbnail', () => ({ Thumbnail: () => <div /> }))
vi.mock('../src/renderer/src/components/PreviewMinimap', () => ({ PreviewMinimap: () => <i /> }))
vi.mock('../src/renderer/src/components/ScopeMenu', () => ({ ScopeMenu: () => <b /> }))
vi.mock('../src/renderer/src/components/ZoomablePreview', () => ({
  ZoomablePreview: (props: Record<string, unknown>) => {
    zoom.current = props
    return <div data-zoom />
  }
}))
vi.mock('../src/renderer/src/components/ColorScope', () => ({
  ColorScope: (props: Record<string, unknown>) => {
    scope.current = props
    return <div data-testid="scope" />
  }
}))

const region: PreviewRegion = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
const files: X3FFileDTO[] = ['a', 'b'].map((id) => ({
  id,
  path: `/photos/${id}.X3F`,
  fileName: `${id}.X3F`,
  aspectRatio: 4 / 3
}))
type Paint = (url: string, size: { width: number; height: number }) => void
const paint = (width = 640, height = 480): void =>
  act(() => (zoom.current.onPaint as Paint)('u', { width, height }))
const view = (): ReturnType<typeof render> =>
  render(
    <>
      <FileFilmstrip />
      <Inspector />
    </>
  )

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
  useQueueStore.setState({ files, activeId: 'a', selectedIds: new Set(['a']) })
  useScopeSourceStore.setState(useScopeSourceStore.getInitialState())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('measures the visible part of the filmstrip preview', () => {
  view()
  paint()
  const visible = screen.getByRole('tab', { name: 'Visible area' })
  expect(scope.current.region).toBeNull()
  fireEvent.click(visible)
  act(() => (zoom.current.onViewportChange as (r: PreviewRegion | null) => void)(region))
  expect(scope.current.region).toEqual(region)
  // Another photo does not reuse the area.
  act(() => useQueueStore.setState({ activeId: 'b', selectedIds: new Set(['b']) }))
  expect(scope.current.region).toBeNull()
})

it('arms the qualifier on the filmstrip preview and disarms after one use or Escape', () => {
  view()
  paint()
  expect(zoom.current.onImageRegion).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: 'Qualifier' }))
  expect(screen.getByRole('button', { name: 'Qualifier' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  act(() => (zoom.current.onImageRegion as (r: PreviewRegion) => void)(region))
  expect(zoom.current.onImageRegion).toBeUndefined()
  expect(zoom.current.outline).toEqual(region)
  expect(scope.current.region).toEqual(region)
  fireEvent.click(screen.getByRole('button', { name: 'Qualifier' }))
  expect(zoom.current.onImagePoint).toBeDefined()
  // Escape that ends a selection in progress goes through the preview.
  act(() => (zoom.current.onSelectionCancel as () => void)())
  expect(zoom.current.onImagePoint).toBeUndefined()
  expect(zoom.current.outline).toEqual(region)
})

it('goes back to the grid with Escape after the Qualifier and outside text fields', () => {
  const update = vi.fn(async () => {})
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, queueViewMode: 'filmstrip' },
    update
  })
  view()
  paint()
  fireEvent.click(screen.getByRole('button', { name: 'Qualifier' }))
  expect(zoom.current.onImagePoint).toBeDefined()
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(zoom.current.onImagePoint).toBeUndefined()
  const input = document.body.appendChild(document.createElement('input'))
  fireEvent.keyDown(input, { key: 'Escape' })
  input.remove()
  expect(update).not.toHaveBeenCalled()
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(update).toHaveBeenCalledWith({ queueViewMode: 'grid' })
})

it('drops the area when the photo changes and comes back', () => {
  view()
  paint()
  fireEvent.click(screen.getByRole('button', { name: 'Qualifier' }))
  act(() => (zoom.current.onImageRegion as (r: PreviewRegion) => void)(region))
  act(() => useQueueStore.setState({ activeId: 'b', selectedIds: new Set(['b']) }))
  paint()
  act(() => useQueueStore.setState({ activeId: 'a', selectedIds: new Set(['a']) }))
  paint()
  expect(zoom.current.outline).toBeNull()
  expect(scope.current.region).toBeNull()
})

it('waits for the painted preview and disarms when several photos are selected', () => {
  view()
  const qualifier = screen.getByRole('button', { name: 'Qualifier' }) as HTMLButtonElement
  expect(qualifier.disabled).toBe(true)
  paint()
  expect(qualifier.disabled).toBe(false)
  fireEvent.click(qualifier)
  expect(zoom.current.onImagePoint).toBeDefined()
  act(() => useQueueStore.setState({ selectedIds: new Set(['a', 'b']) }))
  expect(zoom.current.onImagePoint).toBeUndefined()
  expect(zoom.current.onImageRegion).toBeUndefined()
})

it('shapes a point by the painted image', () => {
  view()
  paint(300, 600)
  fireEvent.click(screen.getByRole('button', { name: 'Qualifier' }))
  act(() => (zoom.current.onImagePoint as (x: number, y: number) => void)(0.5, 0.5))
  const area = zoom.current.outline as PreviewRegion
  expect(area.width / area.height).toBeCloseTo(2)
})

it('disables Visible and Qualifier without a zoomable preview of the photo', () => {
  useQueueStore.setState({ selectedIds: new Set(['a', 'b']) })
  const { rerender } = view()
  expect(screen.queryByRole('button', { name: 'Qualifier' })).toBeNull()
  useQueueStore.setState({ selectedIds: new Set(['a']) })
  rerender(<Inspector />)
  expect((screen.getByRole('button', { name: 'Qualifier' }) as HTMLButtonElement).disabled).toBe(
    true
  )
  expect(screen.getByRole('tab', { name: 'Visible area' }).hasAttribute('disabled')).toBe(true)
})

it('sizes the qualifier square by the oriented shape', () => {
  expect(qualifySquare(0.5, 0.5, 2).height).toBeCloseTo(0.04)
  expect(qualifySquare(0.5, 0.5, 2, 6)).toMatchObject({ height: 0.02, width: 0.04 })
  const edge = qualifySquare(0, 1)
  expect([edge.x, edge.y + edge.height]).toEqual([0, 1])
})

it('waits for the paint of a new preview of the same photo', () => {
  view()
  const qualifier = screen.getByRole('button', { name: 'Qualifier' }) as HTMLButtonElement
  paint()
  expect(qualifier.disabled).toBe(false)
  // A paste of edits gives the photo a new preview.
  act(() =>
    useQueueStore.setState({
      files: files.map((file) =>
        file.id === 'a' ? { ...file, displayPreviewUrl: 'x3f-preview://a?v=2' } : file
      )
    })
  )
  expect(qualifier.disabled).toBe(true)
  paint()
  expect(qualifier.disabled).toBe(false)
})
