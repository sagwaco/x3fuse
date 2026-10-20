import type { KeyboardEvent, MouseEvent } from 'react'

/** Keyboard activation keeps focus for the next control. */
export function blurOnClick(event: MouseEvent<HTMLElement>): void {
  if (event.detail > 0) event.currentTarget.blur()
}

/** Enter ends an adjustment. IME confirmation keeps the control active. */
export function blurOnEnter(event: KeyboardEvent<HTMLElement | SVGElement>): void {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
    return
  event.preventDefault()
  event.stopPropagation()
  event.currentTarget.blur()
}
