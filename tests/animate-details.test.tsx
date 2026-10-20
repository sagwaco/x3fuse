// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { animateDetails } from '../src/renderer/src/lib/animateDetails'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('closes at the end of the animation, turns back on a second click, and shows an opened section', () => {
  const animations: Array<{ cancel: () => void; onfinish: (() => void) | null }> = []
  Object.assign(HTMLElement.prototype, {
    animate: vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null }
      animations.push(animation)
      return animation
    })
  })
  const scroll = vi.fn()
  HTMLElement.prototype.scrollIntoView = scroll
  render(
    <details open>
      <summary onClick={animateDetails}>Light</summary>
      <p>Exposure</p>
    </details>
  )
  const summary = screen.getByText('Light')
  const details = summary.parentElement as HTMLDetailsElement

  fireEvent.click(summary)
  expect(details.open).toBe(true)
  expect(details.hasAttribute('data-closing')).toBe(true)
  animations[0].onfinish!()
  expect(details.open).toBe(false)
  expect(details.hasAttribute('data-closing')).toBe(false)
  expect(scroll).not.toHaveBeenCalled()

  fireEvent.click(summary)
  expect(details.open).toBe(true)
  // A click during the opening closes it again.
  fireEvent.click(summary)
  expect(animations[1].cancel).toHaveBeenCalled()
  expect(details.hasAttribute('data-closing')).toBe(true)
  // And another one opens it.
  fireEvent.click(summary)
  expect(details.hasAttribute('data-closing')).toBe(false)
  animations[3].onfinish!()
  expect(details.open).toBe(true)
  expect(scroll).toHaveBeenCalledTimes(1)
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate
})
