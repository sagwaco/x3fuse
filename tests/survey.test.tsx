// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DEFAULT_SETTINGS, type X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../src/renderer/src/stores/queueStore'
import { useSettingsStore } from '../src/renderer/src/stores/settingsStore'
import { SurveyView } from '../src/renderer/src/components/SurveyView'
import { NO_FILTER } from '../src/renderer/src/lib/culling'

vi.mock('../src/renderer/src/lib/ipc', () => ({ ipc: { invoke: vi.fn(async () => null) } }))
vi.mock('../src/renderer/src/components/Thumbnail', () => ({
  Thumbnail: ({ file }: { file: X3FFileDTO }) => <div data-cell={file.id} />
}))
vi.mock('../src/renderer/src/components/FilmstripImage', () => ({
  FilmstripImage: ({ file }: { file: X3FFileDTO }) => <div data-tile={file.id} />
}))

const files: X3FFileDTO[] = ['a', 'b', 'c'].map((id) => ({
  id,
  path: `/photos/${id}.X3F`,
  fileName: `${id}.X3F`
}))
const selected = (): string[] => [...useQueueStore.getState().selectedIds].sort()

beforeEach(() => {
  useQueueStore.setState({
    files,
    selectedIds: new Set(['a', 'b']),
    activeId: 'a',
    filter: NO_FILTER
  })
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, queueViewMode: 'survey' },
    loaded: true
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400)
  HTMLElement.prototype.scrollTo = () => {}
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('adds strip photos to the survey, and Cmd-click removes them', () => {
  const view = render(<SurveyView />)
  const cell = (id: string): Element =>
    view.container.querySelector(`[data-filmstrip] [data-cell="${id}"]`)!.parentElement!
  fireEvent.click(cell('c'))
  expect(selected()).toEqual(['a', 'b', 'c'])
  expect(useQueueStore.getState().activeId).toBe('c')
  fireEvent.click(cell('a'), { metaKey: true })
  expect(selected()).toEqual(['b', 'c'])
  expect(view.container.querySelectorAll('[data-tile]')).toHaveLength(2)
})

it('shows the hovered photo over the window while Space is held, or until the next Space', () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const view = render(<SurveyView />)
  const peek = (): Element | null => view.queryByRole('dialog')
  fireEvent.pointerEnter(view.container.querySelector('[data-tile="b"]')!.parentElement!)
  fireEvent.keyDown(document.body, { key: ' ' })
  expect(peek()?.querySelector('[data-tile="b"]')).not.toBeNull()
  expect(useQueueStore.getState().activeId).toBe('b')
  now = 1000
  fireEvent.keyUp(document.body, { key: ' ' })
  expect(peek()).toBeNull()

  // A quick press keeps it until Space or Escape.
  fireEvent.keyDown(document.body, { key: ' ' })
  now += 50
  fireEvent.keyUp(document.body, { key: ' ' })
  expect(peek()).not.toBeNull()
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(peek()).toBeNull()

  // It follows the active photo, and closes when the survey has none.
  fireEvent.keyDown(document.body, { key: ' ' })
  act(() => useQueueStore.getState().setSelection(new Set(['a']), 'a'))
  expect(peek()?.querySelector('[data-tile="a"]')).not.toBeNull()
  act(() => useQueueStore.getState().setSelection(new Set(), null))
  expect(peek()).toBeNull()
})

it('leaves Space to a focused remove button, and closes the photo when the window loses focus', () => {
  const view = render(<SurveyView />)
  const remove = view.getAllByRole('button', { name: 'Remove from survey' })[0]
  remove.focus()
  expect(fireEvent.keyDown(remove, { key: ' ' })).toBe(true)
  expect(view.queryByRole('dialog')).toBeNull()
  fireEvent.keyDown(document.body, { key: ' ' })
  expect(view.queryByRole('dialog')).not.toBeNull()
  fireEvent.blur(window)
  expect(view.queryByRole('dialog')).toBeNull()
})
