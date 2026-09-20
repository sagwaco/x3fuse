// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NativeMenuRequest } from '@shared/ipc'
import { QueueContextMenu } from '../src/renderer/src/components/QueueContextMenu'
import { useQueueSelection } from '../src/renderer/src/hooks/useQueueSelection'
import { useQueueStore } from '../src/renderer/src/stores/queueStore'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke } }))
const files = ['a', 'b'].map((id) => ({ id, path: `/photos/${id}.X3F`, fileName: `${id}.X3F` }))
let choose: (value: string | null) => void
const request = (): NativeMenuRequest =>
  invoke.mock.calls.filter(([channel]) => channel === 'menu:popup').at(-1)![1]

function Surface({ disabled = false }: { disabled?: boolean }) {
  const selection = useQueueSelection(files, { mode: 'vertical' })
  return (
    <QueueContextMenu disabled={disabled}>
      <div
        data-testid="surface"
        tabIndex={0}
        onContextMenu={selection.handleContainerContextMenu}
        onKeyDown={selection.handleKeyDown}
      >
        {files.map((file) => (
          <div key={file.id} onContextMenu={() => selection.handleItemContextMenu(file.id)}>
            {file.id}
          </div>
        ))}
      </div>
    </QueueContextMenu>
  )
}

beforeEach(() => {
  useQueueStore.setState({
    files,
    selectedIds: new Set(['a']),
    activeId: 'a',
    isProcessing: false,
    isPreparing: false,
    isCancelling: false,
    draft: null
  })
  invoke.mockImplementation(async (channel) =>
    channel === 'menu:popup'
      ? new Promise((resolve) => {
          choose = resolve
        })
      : undefined
  )
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('opens at the pointer after row selection and removes the clicked file', async () => {
  render(<Surface />)
  expect(fireEvent.contextMenu(screen.getByText('b'), { clientX: 120, clientY: 80 })).toBe(false)
  expect(request()).toMatchObject({
    x: 120,
    y: 80,
    items: [
      { value: 'convert', disabled: false },
      { value: 'remove', disabled: false, separatorBefore: true },
      { value: 'reveal' },
      { value: 'deselect' }
    ]
  })
  expect(useQueueStore.getState().selectedIds).toEqual(new Set(['b']))
  expect(screen.queryByRole('menu')).toBeNull()
  await act(async () => choose('remove'))
  expect(useQueueStore.getState().files).toEqual([files[0]])
})

it('preserves multi-selection, reveals its files, and offers all-file actions on empty space', async () => {
  useQueueStore.setState({ selectedIds: new Set(['a', 'b']) })
  render(<Surface />)
  fireEvent.contextMenu(screen.getByText('b'))
  await act(async () => choose('reveal'))
  for (const file of files) expect(invoke).toHaveBeenCalledWith('shell:reveal', { path: file.path })
  fireEvent.contextMenu(screen.getByTestId('surface'))
  expect(useQueueStore.getState().selectedIds.size).toBe(0)
  expect(request().items.map((item) => item.value)).toEqual(['convert', 'remove'])
  await act(async () => choose('remove'))
  expect(useQueueStore.getState().files).toEqual([])
})

it('supports keyboard invocation, busy states, and invalidation when disabled or unmounted', async () => {
  useQueueStore.setState({ isProcessing: true })
  const view = render(<Surface />)
  const surface = screen.getByTestId('surface')
  fireEvent.keyDown(surface, { key: 'F10', shiftKey: true })
  expect(request().items.find((item) => item.value === 'stop')).toBeDefined()
  expect(request().items.find((item) => item.value === 'remove')?.disabled).toBe(true)
  await act(async () => choose('remove'))
  expect(useQueueStore.getState().files).toEqual(files)
  useQueueStore.setState({ isProcessing: false })
  fireEvent.keyDown(surface, { key: 'ContextMenu' })
  view.rerender(<Surface disabled />)
  await act(async () => choose('remove'))
  expect(useQueueStore.getState().files).toEqual(files)
  invoke.mockClear()
  fireEvent.contextMenu(surface)
  expect(invoke).not.toHaveBeenCalled()
  view.rerender(<Surface />)
  fireEvent.contextMenu(screen.getByText('b'))
  view.unmount()
  await act(async () => choose('remove'))
  expect(useQueueStore.getState().files).toEqual(files)
})
