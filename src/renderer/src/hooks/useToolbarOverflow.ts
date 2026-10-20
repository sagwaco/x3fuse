import { useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react'

const px = (value: string): number => parseFloat(value) || 0

/** The width the toolbar children need, and the width the toolbar has for them. */
function measure(el: HTMLElement): { used: number; room: number } {
  const style = getComputedStyle(el)
  const children = [...el.children]
  return {
    used:
      children.reduce((sum, child) => sum + child.scrollWidth, 0) +
      px(style.columnGap) * Math.max(0, children.length - 1),
    room: el.clientWidth - px(style.paddingLeft) - px(style.paddingRight)
  }
}

/**
 * Counts the toolbar buttons that do not fit. Each step hides one more button until the
 * content fits. A button returns when the free room is as wide as the space it freed, so a
 * shrinking toolbar part (such as the zoom controls) also brings buttons back. A
 * ResizeObserver on the toolbar and its descendants measures content that changes alone.
 */
export function useToolbarOverflow(ref: RefObject<HTMLElement | null>, max: number): number {
  const [hidden, setHidden] = useState(0)
  const [, measureAgain] = useReducer((n: number) => n + 1, 0)
  // The width each fold freed, and the content width just before the latest fold.
  const freed = useRef<number[]>([])
  const before = useRef<number | null>(null)
  const observer = useRef<ResizeObserver | null>(null)
  // The last measurement. Each new observation reports once, so the observer renders
  // again only for a change; otherwise each render would cause the next one.
  const last = useRef('')
  // Runs after every render, so a content change is measured too. Each step ends at a fit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    observer.current?.disconnect()
    // Crop mode does not fold. The state stays for the way back.
    if (max === 0) return
    const { used, room } = measure(el)
    last.current = `${used},${room}`
    if (typeof ResizeObserver !== 'undefined') {
      observer.current ??= new ResizeObserver(() => {
        const box = ref.current
        if (!box) return
        const size = measure(box)
        if (`${size.used},${size.room}` !== last.current) measureAgain()
      })
      observer.current.observe(el)
      el.querySelectorAll(':scope > *, :scope > * > *, :scope > * > * > *').forEach((node) =>
        observer.current?.observe(node)
      )
    }
    // The swap animation scales buttons past their size, and a transform adds to the scroll
    // width. A fold then would undo itself. Measure again when the buttons stop moving.
    const moving = [...el.querySelectorAll('button')]
      .flatMap((button) => button.getAnimations?.() ?? [])
      .filter((animation) => animation.playState === 'running')
    if (moving.length) {
      void Promise.all(moving.map((animation) => animation.finished.catch(() => {}))).then(
        measureAgain
      )
      return
    }
    if (before.current !== null) {
      freed.current[hidden - 1] = Math.max(1, before.current - used)
      before.current = null
    }
    const over =
      used > room + 0.5 || [el, ...el.children].some((b) => b.scrollWidth > b.clientWidth)
    if (over && hidden < max) {
      before.current = used
      setHidden(hidden + 1)
    } else if (!over && hidden > 0 && room - used >= (freed.current[hidden - 1] ?? 0)) {
      setHidden(hidden - 1)
    }
  })
  useLayoutEffect(() => () => observer.current?.disconnect(), [])
  return Math.min(hidden, max)
}
