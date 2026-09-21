// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { FileQueue } from '../src/renderer/src/components/FileQueue'
import { ResizablePanel } from '../src/renderer/src/components/ui/resizablePanel'
import { useQueueStore } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))
vi.mock('../src/renderer/src/lib/previewImages', () => ({
  cachedSmallPreview: () => undefined,
  loadSmallPreview: () => new Promise(() => {})
}))

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(960)
  HTMLElement.prototype.scrollTo = vi.fn()
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    measureText: (text: string) => ({ width: text.length * 7 })
  } as unknown as CanvasRenderingContext2D)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: true })
  const files = Array.from({ length: 250 }, (_, index) => ({
    id: String(index),
    path: `/photos/${index}.X3F`,
    fileName: index === 249 ? 'z'.repeat(160) + '.X3F' : `image-${index}.X3F`,
    capturedDate: '2026-09-20T12:00:00Z',
    fileSize: 12345678
  }))
  useQueueStore.setState({ files, selectedIds: new Set(['0']), activeId: '0', draft: null })
  invoke.mockReset()
  invoke.mockImplementation(async (channel, patch) => {
    if (channel === 'settings:set') return { ...useSettingsStore.getState().settings, ...patch }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function columnWidths(container: HTMLElement): number[] {
  return container
    .querySelector<HTMLElement>('[style*="--queue-columns"]')!
    .style.getPropertyValue('--queue-columns')
    .split(' ')
    .map(parseFloat)
}

it.each([
  ['Date', 1],
  ['Size', 2]
] as const)(
  'moves the %s separator without changing other columns and saves the geometry',
  async (name, index) => {
    const view = render(<FileQueue />)
    const handle = screen.getByRole('separator', { name: `Resize ${name} column` })
    const initial = columnWidths(view.container)
    expect(useSettingsStore.getState().settings.listColumnWidths.name).toBe(0)
    fireEvent.pointerDown(handle, { button: 0, clientX: 200 })
    fireEvent.pointerMove(handle, { clientX: 300 })
    const resized = columnWidths(view.container)
    expect(resized).toEqual(initial.map((width, column) => width + (column === index ? 100 : 0)))
    expect(resized.slice(0, index + 1).reduce((a, b) => a + b, 0)).toBe(
      initial.slice(0, index + 1).reduce((a, b) => a + b, 0) + 100
    )
    expect(invoke).not.toHaveBeenCalled()
    await act(async () => fireEvent.pointerUp(handle, { clientX: 300 }))
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().settings.listColumnWidths).toEqual({
      name: resized[0],
      date: resized[1],
      size: resized[2]
    })
    view.unmount()
    expect(columnWidths(render(<FileQueue />).container)).toEqual(resized)
  }
)

it.each(['cancel', 'no movement'])('keeps automatic Name sizing after a drag with %s', (end) => {
  const view = render(<FileQueue />)
  const initial = columnWidths(view.container)
  const handle = screen.getByRole('separator', { name: 'Resize Date column' })
  fireEvent.pointerDown(handle, { button: 0, clientX: 200 })
  if (end === 'cancel') {
    fireEvent.pointerMove(handle, { clientX: 300 })
    fireEvent.pointerCancel(handle)
  } else fireEvent.pointerUp(handle, { clientX: 200 })
  expect(columnWidths(view.container)).toEqual(initial)
  expect(useSettingsStore.getState().settings.listColumnWidths.name).toBe(0)
  expect(invoke).not.toHaveBeenCalled()
})

it.each([
  ['Date', 1, 'ArrowRight'],
  ['Size', 2, 'ArrowRight'],
  ['Date', 1, 'Enter'],
  ['Size', 2, 'Enter']
] as const)('preserves other columns when resizing %s (column %i) with %s', async (name, index, key) => {
  const view = render(<FileQueue />)
  const initial = columnWidths(view.container)
  await act(async () =>
    fireEvent.keyDown(screen.getByRole('separator', { name: `Resize ${name} column` }), { key })
  )
  const resized = columnWidths(view.container)
  expect(resized[index]).not.toBe(initial[index])
  expect(resized.filter((_, column) => column !== index)).toEqual(
    initial.filter((_, column) => column !== index)
  )
  expect(useSettingsStore.getState().settings.listColumnWidths.name).toBe(initial[0])
  expect(useQueueStore.getState().activeId).toBe('0')
})

it.each([
  [960.75, 590],
  [420, 180],
  [3840, 2000]
])(
  'keeps automatic Name width valid at %spx before and after saving',
  async (available, expected) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(available)
    const view = render(<FileQueue />)
    expect(columnWidths(view.container)[0]).toBe(expected)
    await act(async () =>
      fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Date column' }), {
        key: 'ArrowRight'
      })
    )
    expect(columnWidths(view.container)[0]).toBe(expected)
    expect(useSettingsStore.getState().settings.listColumnWidths.name).toBe(expected)
  }
)

it('resizes columns without sorting, commits once on release, and fits offscreen content', async () => {
  const view = render(<FileQueue />)
  const handle = screen.getByRole('separator', { name: 'Resize Name column' })
  const initial = Number(handle.getAttribute('aria-valuenow'))
  fireEvent.pointerDown(handle, { button: 0, clientX: 200 })
  fireEvent.pointerMove(handle, { clientX: 300 })
  expect(handle.getAttribute('aria-valuenow')).toBe(String(initial + 100))
  expect(invoke).not.toHaveBeenCalled()
  fireEvent.pointerUp(handle, { clientX: 300 })
  await waitFor(() =>
    expect(useSettingsStore.getState().settings.listColumnWidths.name).toBe(initial + 100)
  )
  expect(invoke).toHaveBeenCalledTimes(1)
  const sort = useSettingsStore.getState().settings.sortAscending
  fireEvent.doubleClick(handle)
  await waitFor(() =>
    expect(useSettingsStore.getState().settings.listColumnWidths.name).toBeGreaterThan(1100)
  )
  expect(useSettingsStore.getState().settings.sortAscending).toBe(sort)
  expect(useSettingsStore.getState().settings.queueViewMode).toBe('list')
  const width = useSettingsStore.getState().settings.listColumnWidths.name
  view.unmount()
  render(<FileQueue />)
  expect(
    screen.getByRole('separator', { name: 'Resize Name column' }).getAttribute('aria-valuenow')
  ).toBe(String(width))
})

it('clamps and cancels drags, and supports keyboard resizing and fitting for every column', async () => {
  render(<FileQueue />)
  const handle = screen.getByRole('separator', { name: 'Resize Name column' })
  const initial = handle.getAttribute('aria-valuenow')
  fireEvent.pointerDown(handle, { button: 0, clientX: 200 })
  fireEvent.pointerMove(handle, { clientX: -10000 })
  expect(handle.getAttribute('aria-valuenow')).toBe('180')
  fireEvent.pointerCancel(handle)
  expect(handle.getAttribute('aria-valuenow')).toBe(initial)
  expect(invoke).not.toHaveBeenCalled()
  for (const name of ['Name', 'Date', 'Size']) {
    const edge = screen.getByRole('separator', { name: `Resize ${name} column` })
    const value = Number(edge.getAttribute('aria-valuenow'))
    await act(async () => fireEvent.keyDown(edge, { key: 'ArrowRight' }))
    expect(edge.getAttribute('aria-valuenow')).toBe(String(value + 10))
    await act(async () => fireEvent.keyDown(edge, { key: 'Enter' }))
    expect(Number(edge.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(
      Number(edge.getAttribute('aria-valuemin'))
    )
  }
  expect(useQueueStore.getState().activeId).toBe('0')
})

it.each(['release', 'cancel', 'lost capture', 'unmount'])(
  'keeps the resize cursor across the document until %s',
  (end) => {
    const view = render(<FileQueue />)
    const handle = screen.getByRole('separator', { name: 'Resize Name column' })
    const root = document.documentElement
    expect(root.classList.contains('resizing-columns')).toBe(false)
    fireEvent.pointerDown(handle, { button: 0, clientX: 200 })
    fireEvent.pointerMove(handle, { clientX: 2000 })
    fireEvent.pointerMove(document.body, { clientX: 4000 })
    expect(root.classList.contains('resizing-columns')).toBe(true)
    if (end === 'release') fireEvent.pointerUp(handle)
    else if (end === 'cancel') fireEvent.pointerCancel(handle)
    else if (end === 'lost capture') fireEvent.lostPointerCapture(handle)
    else view.unmount()
    expect(root.classList.contains('resizing-columns')).toBe(false)
  }
)

it('renders virtualized thumbnails beside filenames and retains native titles and selection', () => {
  const view = render(<FileQueue />)
  const cell = screen.getByTitle('image-0.X3F')
  const preview = cell.querySelector('canvas')!
  expect(preview).toBeTruthy()
  expect(preview.closest('[aria-hidden="true"]')).toBeTruthy()
  expect(view.container.querySelectorAll('canvas').length).toBeLessThan(50)
  fireEvent.click(preview)
  expect(useQueueStore.getState().selectedIds).toEqual(new Set(['0']))
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it.each(['inspector', 'export'] as const)(
  'resizes and restores the %s panel and preserves the width on remount',
  async (kind) => {
    const key = kind === 'inspector' ? 'inspectorWidth' : 'exportPanelWidth'
    const initial = DEFAULT_SETTINGS[key]
    const view = render(
      <div>
        <ResizablePanel kind={kind}>Panel content</ResizablePanel>
      </div>
    )
    const panel = screen.getByRole('complementary')
    const handle = screen.getByRole('separator')
    expect(panel.style.width).toBe(`${initial}px`)
    fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
    fireEvent.pointerMove(handle, { clientX: 450 })
    expect(panel.style.width).toBe(`${initial + 50}px`)
    expect(invoke).not.toHaveBeenCalled()
    await act(async () => fireEvent.pointerUp(handle, { clientX: 450 }))
    expect(useSettingsStore.getState().settings[key]).toBe(initial + 50)
    view.unmount()
    render(
      <div>
        <ResizablePanel kind={kind}>Panel content</ResizablePanel>
      </div>
    )
    expect(screen.getByRole('complementary').style.width).toBe(`${initial + 50}px`)
    await act(async () => fireEvent.doubleClick(screen.getByRole('separator')))
    expect(screen.getByRole('complementary').style.width).toBe(`${initial}px`)
    expect(useSettingsStore.getState().settings[key]).toBe(initial)
  }
)
