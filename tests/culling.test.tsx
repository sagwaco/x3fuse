// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { DEFAULT_SETTINGS, type QueueViewMode, type X3FFileDTO } from '@shared/types'
import { matchesFilter, NO_FILTER, successor, surveyColumns } from '../src/renderer/src/lib/culling'

const invoke = vi.fn<(channel: string, payload: unknown) => Promise<unknown>>()
const listeners = new Map<string, (payload: unknown) => void>()
;(window as unknown as { x3f: unknown }).x3f = {
  invoke,
  on: (channel: string, listener: (payload: unknown) => void) => {
    listeners.set(channel, listener)
    return () => listeners.delete(channel)
  }
}
const { useQueueStore: store } = await import('../src/renderer/src/stores/queueStore')
const { useSettingsStore } = await import('../src/renderer/src/stores/settingsStore')
const { useNavStore } = await import('../src/renderer/src/stores/navStore')
const { useShortcuts } = await import('../src/renderer/src/hooks/useShortcuts')
const { useEditorStore } = await import('../src/renderer/src/stores/editorStore')
const { StarPicker } = await import('../src/renderer/src/components/CullControls')
const { useIpcEvents } = await import('../src/renderer/src/hooks/useIpcEvents')

const files: X3FFileDTO[] = ['a', 'b', 'c', 'd'].map((id) => ({
  id,
  path: `/photos/${id}.X3F`,
  fileName: `${id}.X3F`
}))

function Keys(): null {
  useShortcuts()
  return null
}

const view = (queueViewMode: QueueViewMode): void =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, queueViewMode }, loaded: true })
const flags = (): (string | undefined)[] => store.getState().files.map((file) => file.flag)
const settle = (): Promise<void> => new Promise((done) => setTimeout(done))

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined)
  store.setState({ files, selectedIds: new Set(['a']), activeId: 'a', filter: NO_FILTER })
  useNavStore.setState({ screen: 'queue' })
  view('grid')
  render(<Keys />)
})
afterEach(cleanup)

it('filters by flag and rating, and finds the next shown photo', () => {
  const file = { ...files[0], flag: 'pick' as const, rating: 3 }
  expect(matchesFilter(file, { flags: ['pick'], rating: 3, ratingOp: 'atLeast' })).toBe(true)
  expect(matchesFilter(file, { flags: ['reject'], rating: 0, ratingOp: 'atLeast' })).toBe(false)
  expect(matchesFilter(file, { flags: [], rating: 2, ratingOp: 'exactly' })).toBe(false)
  expect(matchesFilter(files[0], { flags: ['unflagged'], rating: 0, ratingOp: 'atMost' })).toBe(
    true
  )
  const order = ['a', 'b', 'c', 'd']
  expect(successor(order, 'a', new Set(['c', 'd']))).toBe('c')
  expect(successor(order, 'd', new Set(['a', 'd']))).toBe('d')
  expect(successor(order, 'd', new Set(['b']))).toBe('b')
  expect(successor(order, 'b', new Set())).toBeNull()
  expect(surveyColumns(2, 1200, 400)).toBe(2)
  expect(surveyColumns(4, 600, 800)).toBe(1)
})

it('flags the selection in grid, saves it, and advances with Shift', async () => {
  store.setState({ selectedIds: new Set(['a', 'b']) })
  fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ' })
  expect(flags()).toEqual(['pick', 'pick', undefined, undefined])
  await settle()
  expect(invoke).toHaveBeenCalledWith('culling:set', {
    paths: ['/photos/a.X3F', '/photos/b.X3F'],
    flag: 'pick'
  })
  fireEvent.keyDown(document.body, { key: '#', code: 'Digit3', shiftKey: true })
  expect(store.getState().files[0].rating).toBe(3)
  expect(store.getState().activeId).toBe('b')
  expect(store.getState().selectedIds).toEqual(new Set(['b']))
  // Text fields and repeated keys do not cull.
  const input = document.createElement('input')
  document.body.append(input)
  fireEvent.keyDown(input, { key: 'x', code: 'KeyX' })
  fireEvent.keyDown(document.body, { key: 'x', code: 'KeyX', repeat: true })
  expect(store.getState().files[1].flag).toBe('pick')
  input.remove()
  await settle()
})

it('moves to the next shown photo when a decision hides the active photo', async () => {
  view('filmstrip')
  store.getState().setFilter({ flags: ['unflagged'] })
  store.setState({ selectedIds: new Set(['a', 'b']), activeId: 'a' })
  // Filmstrip applies to the active photo only.
  fireEvent.keyDown(document.body, { key: 'x', code: 'KeyX' })
  expect(flags()).toEqual(['reject', undefined, undefined, undefined])
  expect(store.getState().activeId).toBe('b')
  expect(store.getState().selectedIds).toEqual(new Set(['b']))
  // A filter that hides the selection moves the cursor to the nearest shown photo.
  store.getState().setFilter({ flags: ['reject'] })
  expect(store.getState().activeId).toBe('a')
  await settle()
})

it('keeps a survey on its photos and removes hidden ones from it', async () => {
  view('survey')
  store.getState().setFilter({ flags: ['unflagged'] })
  store.setState({ selectedIds: new Set(['a', 'c', 'd']), activeId: 'a' })
  fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ' })
  expect(store.getState().activeId).toBe('c')
  expect(store.getState().selectedIds).toEqual(new Set(['c', 'd']))
  fireEvent.keyDown(document.body, { key: '!', code: 'Digit1', shiftKey: true })
  expect(store.getState().files[2].rating).toBe(1)
  expect(store.getState().activeId).toBe('d')
  await settle()
})

it('shows the saved values again when a save fails', async () => {
  invoke.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('disk full'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ' })
  fireEvent.keyDown(document.body, { key: 'x', code: 'KeyX' })
  fireEvent.keyDown(document.body, { key: 'u', code: 'KeyU' })
  expect(flags()[0]).toBe('unflagged')
  await settle()
  expect(flags()[0]).toBe('pick')
})

it('keeps a later saved decision when an earlier save fails, and reports the failure', async () => {
  // Paths that no earlier test saved.
  store.setState({ files: files.map((file) => ({ ...file, path: `/other${file.path}` })) })
  invoke.mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ' })
  fireEvent.keyDown(document.body, { key: 'x', code: 'KeyX' })
  fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ' })
  await settle()
  expect(flags()[0]).toBe('pick')
  expect(store.getState().cullError).toBeNull()
  invoke.mockRejectedValueOnce(new Error('disk full'))
  fireEvent.keyDown(document.body, { key: '2', code: 'Digit2' })
  await settle()
  expect(store.getState().files[0].rating).toBeUndefined()
  expect(store.getState().cullError).toContain('disk full')
})

it('targets the photo the filmstrip shows after a filter that matched nothing is cleared', async () => {
  view('filmstrip')
  store.getState().setFilter({ flags: ['reject'] })
  expect(store.getState().activeId).toBeNull()
  store.getState().setFilter(NO_FILTER)
  fireEvent.keyDown(document.body, { key: 'Z', code: 'KeyZ', shiftKey: true })
  expect(flags()[0]).toBe('pick')
  expect(store.getState().activeId).toBe('b')
  await settle()
})

it('toggles Z and X, and culls only the open photo in the editor', async () => {
  store.setState({ selectedIds: new Set(['a', 'b']) })
  fireEvent.keyDown(document.body, { key: 'x', code: 'KeyX' })
  fireEvent.keyDown(document.body, { key: 'x', code: 'KeyX' })
  expect(flags().slice(0, 2)).toEqual(['unflagged', 'unflagged'])
  store.getState().setCull(new Set(['a']), { flag: 'pick' })
  // A mixed selection is picked; a fully picked one is cleared.
  fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ' })
  expect(flags().slice(0, 2)).toEqual(['pick', 'pick'])
  fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ' })
  expect(flags().slice(0, 2)).toEqual(['unflagged', 'unflagged'])

  useNavStore.setState({ screen: 'editor' })
  fireEvent.keyDown(document.body, { key: '$', code: 'Digit4', shiftKey: true })
  expect(store.getState().files.map((file) => file.rating ?? 0)).toEqual([4, 0, 0, 0])
  expect(store.getState().activeId).toBe('b')
  // View keys stay on the queue screen, and crop mode keeps its keys.
  fireEvent.keyDown(document.body, { key: 'e', code: 'KeyE' })
  expect(useSettingsStore.getState().settings.queueViewMode).toBe('grid')
  useEditorStore.setState({ cropping: true })
  fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ' })
  expect(store.getState().files[1].flag).toBe('unflagged')
  useEditorStore.setState({ cropping: false })
  await settle()
})

it('fills the stars up to the hovered or focused star', () => {
  const change = vi.fn()
  const view = render(<StarPicker value={1} onChange={change} />)
  const stars = view.getAllByRole('button')
  const filled = (): number => view.container.querySelectorAll('svg.fill-current').length
  expect(filled()).toBe(1)
  fireEvent.pointerEnter(stars[3])
  expect(filled()).toBe(4)
  fireEvent.pointerLeave(stars[3].parentElement!)
  fireEvent.focus(stars[2])
  expect(filled()).toBe(3)
  fireEvent.click(stars[0])
  expect(change).toHaveBeenCalledWith(0)
})

it('finishes closing the window only after queued flags and ratings are saved', async () => {
  function Events(): null {
    useIpcEvents()
    return null
  }
  render(<Events />)
  let saved!: () => void
  invoke.mockImplementation(async (channel) =>
    channel === 'culling:set' ? new Promise<void>((done) => (saved = done)) : undefined
  )
  fireEvent.keyDown(document.body, { key: 'z', code: 'KeyZ' })
  await settle()
  listeners.get('editor:closing')!({ quit: true })
  await settle()
  expect(invoke.mock.calls.some(([channel]) => channel === 'editor:finishClose')).toBe(false)
  saved()
  await settle()
  expect(invoke).toHaveBeenLastCalledWith('editor:finishClose', { quit: true })
  useEditorStore.setState({ closing: false })
})

it('advances in the editor from its open photo after a filter that matched nothing is cleared', async () => {
  useNavStore.setState({ screen: 'editor' })
  useEditorStore.setState({ session: { path: '/photos/a.X3F' } as never })
  store.getState().setFilter({ flags: ['reject'] })
  expect(store.getState().activeId).toBeNull()
  store.getState().setFilter(NO_FILTER)
  fireEvent.keyDown(document.body, { key: '#', code: 'Digit3', shiftKey: true })
  expect(store.getState().files[0].rating).toBe(3)
  expect(store.getState().activeId).toBe('b')
  useEditorStore.setState({ session: null })
  await settle()
})

it('does not add a photo from outside the survey when a filter hides the survey', () => {
  view('survey')
  store.setState({
    files: files.map((file) => ({ ...file, flag: file.id === 'c' ? 'reject' : 'pick' })),
    selectedIds: new Set(['a', 'b']),
    activeId: 'a'
  })
  store.getState().setFilter({ flags: ['reject'] })
  expect(store.getState().selectedIds).toEqual(new Set())
  expect(store.getState().activeId).toBeNull()
})
