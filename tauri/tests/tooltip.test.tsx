// @vitest-environment jsdom
import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '../src/renderer/src/components/ui/button'
import { Tooltip } from '../src/renderer/src/components/ui/tooltip'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('keeps title tooltips native and preserves button refs, names and actions', () => {
  const ref = createRef<HTMLButtonElement>()
  const onClick = vi.fn()
  render(
    <Button ref={ref} size="icon" title="Zoom in" onClick={onClick}>
      +
    </Button>
  )
  const button = screen.getByTitle('Zoom in')
  expect(ref.current).toBe(button)
  expect(button.getAttribute('title')).toBe('Zoom in')
  act(() => button.focus())
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.click(button)
  expect(onClick).toHaveBeenCalledOnce()
})

it('opens text tooltips on hover without adding layout wrappers', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  const view = render(
    <Tooltip text="/photos/image.X3F">
      <span>image.X3F</span>
    </Tooltip>
  )
  const label = screen.getByText('image.X3F')
  expect(view.container.firstElementChild).toBe(label)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.pointerMove(label, { pointerType: 'mouse' })
  expect((await screen.findByRole('tooltip')).textContent).toBe('/photos/image.X3F')
  expect(document.querySelector('.export-help-tooltip')).toBeNull()
  fireEvent.pointerLeave(label, { clientX: 10, clientY: 10 })
  fireEvent.pointerMove(document.body, { clientX: 100, clientY: 100 })
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
})

it('leaves empty text alone and preserves disabled buttons and explicit labels', () => {
  const onClick = vi.fn()
  const view = render(
    <Tooltip text="">
      <span>Empty</span>
    </Tooltip>
  )
  expect(view.container.innerHTML).toBe('<span>Empty</span>')
  render(
    <Button size="icon" title="Help" aria-label="Details" disabled onClick={onClick}>
      ?
    </Button>
  )
  const button = screen.getByRole('button', { name: 'Details' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(onClick).not.toHaveBeenCalled()
})

it('keeps a tooltip button working as a dialog trigger', async () => {
  render(
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button title="Show results">Results</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Content>
          <Dialog.Title>Export results</Dialog.Title>
          <Dialog.Description>Completed files</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Results' }))
  expect(await screen.findByRole('dialog', { name: 'Export results' })).toBeTruthy()
})
