// @vitest-environment jsdom
import { useState, type Dispatch, type SetStateAction } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { defaultRecipe, type EditRecipe } from '@shared/editor'
import { ColorMixer, ToneMixer } from '../src/renderer/src/components/ColorMixer'
import { useEditorStore as editor } from '../src/renderer/src/stores/editorStore'
import { useQueueStore as queue } from '../src/renderer/src/stores/queueStore'
import { t } from '../src/renderer/src/lib/strings'

const originalChange = editor.getState().change
const originalCommit = editor.getState().commit
const change = vi.fn()
const commit = vi.fn()
let recipe: EditRecipe
let setRecipe: Dispatch<SetStateAction<EditRecipe>>
function Mixer({
  tone = false,
  initial = defaultRecipe()
}: {
  tone?: boolean
  initial?: EditRecipe
}): React.JSX.Element {
  const [current, update] = useState(initial)
  recipe = current
  setRecipe = update
  return tone ? <ToneMixer recipe={current} /> : <ColorMixer recipe={current} />
}
const COLORS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  change
    .mockReset()
    .mockImplementation((patch: Partial<EditRecipe>) =>
      setRecipe((recipe) => ({ ...recipe, ...patch }))
    )
  commit.mockReset()
  queue.setState({ isProcessing: false, isPreparing: false })
  editor.setState({
    preview: {
      sessionId: 'mixer',
      revision: 0,
      url: 'preview',
      width: 1200,
      height: 800,
      sourceWidth: 6000,
      sourceHeight: 4000
    },
    loading: false,
    closing: false,
    before: false,
    change,
    commit
  })
})
afterEach(() => {
  cleanup()
  editor.setState({ change: originalChange, commit: originalCommit, preview: null })
  vi.unstubAllGlobals()
})

it('edits one band property per tab with a slider for each color', () => {
  render(<Mixer />)
  const tabs = within(screen.getByRole('tablist', { name: t('editor.colorMixer') })).getAllByRole(
    'tab'
  )
  expect(tabs.map((tab) => tab.textContent)).toEqual(
    ['hue', 'sat', 'val'].map((key) => t(`editor.${key}`))
  )
  expect(screen.getAllByRole('slider').map((slider) => slider.getAttribute('aria-label'))).toEqual(
    COLORS.map((color) => t(`editor.${color}`))
  )
  fireEvent.click(tabs[2])
  expect(tabs[2].getAttribute('aria-selected')).toBe('true')
  const before = recipe.hsl
  fireEvent.keyDown(screen.getByRole('slider', { name: t('editor.blue') }), { key: 'ArrowRight' })
  expect(recipe.hsl[5]).toEqual({ hue: 0, saturation: 0, luminance: 1 })
  expect(recipe.hsl.filter((_, index) => index !== 5)).toEqual(
    before.filter((_, index) => index !== 5)
  )
  // Each row shows the first letter of its color, with the full name as its tooltip.
  // Shift-click on the letter resets only that band's value for the tab.
  fireEvent.change(screen.getByRole('spinbutton', { name: t('editor.green') }), {
    target: { value: '30' }
  })
  const blue = screen.getByTitle(t('editor.blue'))
  expect(blue.textContent).toBe(t('editor.blue')[0])
  fireEvent.click(blue, { shiftKey: true })
  expect(recipe.hsl[5].luminance).toBe(0)
  expect(recipe.hsl[3].luminance).toBe(30)
})

it('moves between tabs with the arrow, Home and End keys', () => {
  render(<Mixer />)
  const tabs = screen.getAllByRole('tab')
  fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' })
  expect(tabs[2].getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(tabs[2])
  fireEvent.keyDown(tabs[2], { key: 'ArrowRight' })
  expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(tabs[0], { key: 'End' })
  expect(tabs[2].getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(tabs[2], { key: 'Home' })
  expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[0].id)
  expect(change).not.toHaveBeenCalled()
})

it('edits and resets all eight tone bands independently of HSL and warmth', () => {
  const initial = {
    ...defaultRecipe(),
    toneMixer: undefined,
    warmth: 25,
    hsl: COLORS.map((_, index) => ({ hue: index, saturation: index + 1, luminance: index + 2 }))
  }
  render(<Mixer tone initial={initial} />)
  expect(screen.queryByRole('tablist')).toBeNull()
  expect(screen.getAllByRole('slider').map((slider) => slider.getAttribute('aria-label'))).toEqual(
    COLORS.map((color) => t(`editor.${color}`))
  )
  for (const color of COLORS) {
    expect(screen.getByTitle(t(`editor.${color}`)).textContent).toBe(t(`editor.${color}`))
    const slider = screen.getByRole('slider', { name: t(`editor.${color}`) })
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
    expect(slider.getAttribute('aria-valuemin')).toBe('-100')
    expect(slider.getAttribute('aria-valuemax')).toBe('100')
  }
  const values = [-80, -60, -40, -20, 20, 40, 60, 80]
  COLORS.forEach((color, index) => {
    fireEvent.change(screen.getByRole('spinbutton', { name: t(`editor.${color}`) }), {
      target: { value: String(values[index]) }
    })
    expect(change).toHaveBeenLastCalledWith({ toneMixer: recipe.toneMixer }, true)
    expect(recipe.toneMixer).toEqual(values.map((value, band) => (band <= index ? value : 0)))
  })
  fireEvent.keyDown(screen.getByRole('slider', { name: t('editor.red') }), { key: 'ArrowRight' })
  expect(recipe.toneMixer).toEqual([-79, ...values.slice(1)])
  expect(change).toHaveBeenLastCalledWith({ toneMixer: recipe.toneMixer }, false)
  expect(commit).toHaveBeenCalledTimes(1)
  fireEvent.doubleClick(screen.getByRole('slider', { name: t('editor.blue') }))
  expect(recipe.toneMixer).toEqual([-79, -60, -40, -20, 20, 0, 60, 80])
  fireEvent.click(screen.getByTitle(t('editor.red')), { shiftKey: true })
  expect(recipe.toneMixer).toEqual([0, -60, -40, -20, 20, 0, 60, 80])
  expect(recipe.hsl).toEqual(initial.hsl)
  expect(recipe.warmth).toBe(25)
})
