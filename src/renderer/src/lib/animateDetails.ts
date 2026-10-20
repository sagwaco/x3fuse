const running = new WeakMap<HTMLDetailsElement, { animation: Animation; opening: boolean }>()

/**
 * The click handler of a summary. It opens or closes the details with a height animation,
 * and scrolls a details that opens into view. A click that a control in the summary
 * prevents does nothing. Without the Web Animations API, the details toggle at once.
 */
export function animateDetails(event: React.MouseEvent<HTMLElement>): void {
  const details = event.currentTarget.parentElement
  if (event.isDefaultPrevented() || !(details instanceof HTMLDetailsElement) || !details.animate)
    return
  event.preventDefault()
  const last = running.get(details)
  // A click during an animation turns it back.
  const opening = last ? !last.opening : !details.open
  const from = details.offsetHeight
  last?.animation.cancel()
  details.open = false
  const closed = details.offsetHeight
  details.open = true
  const open = details.offsetHeight
  // The chevron turns at the start of a close, not at its end.
  details.toggleAttribute('data-closing', !opening)
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  // Clip, not hidden, so that the summary stays sticky.
  details.style.overflow = 'clip'
  const animation = details.animate(
    { height: [`${from}px`, `${opening ? open : closed}px`] },
    { duration: reduce ? 0 : 200, easing: 'ease-out', fill: 'forwards' }
  )
  running.set(details, { animation, opening })
  animation.onfinish = () => {
    running.delete(details)
    details.removeAttribute('data-closing')
    details.style.overflow = ''
    if (!opening) details.open = false
    animation.cancel()
    if (opening) details.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
  }
}
