import { useEffect, useId, useRef, useState } from 'react'
import type { NativeMenuItem } from '@shared/ipc'
import { invalidateNativeMenu, showNativeMenu } from '../../lib/nativeMenu'
import { Button, type ButtonProps } from './button'

interface NativeMenuButtonProps extends Omit<ButtonProps, 'onSelect' | 'onClick'> {
  items: NativeMenuItem[]
  onSelect: (value: string) => void
}

/** The OS owns menu rendering, keyboard navigation, and outside-click dismissal. */
export function NativeMenuButton({
  items,
  onSelect,
  disabled,
  ...props
}: NativeMenuButtonProps): React.JSX.Element {
  const id = useId()
  const pending = useRef<object | null>(null)
  const [open, setOpen] = useState(false)
  const latest = useRef({ items, onSelect })
  latest.current = { items, onSelect }

  useEffect(() => {
    setOpen(false)
    return () => {
      invalidateNativeMenu(id)
      if (pending.current) {
        pending.current = null
      }
    }
  }, [id, disabled])

  async function show(button: HTMLButtonElement): Promise<void> {
    if (pending.current || button.matches(':disabled') || items.length === 0) return
    const bounds = button.getBoundingClientRect()
    const request = {}
    pending.current = request
    setOpen(true)
    button.focus()
    try {
      await showNativeMenu(
        {
          id,
          x: Math.max(0, bounds.left),
          y: Math.max(0, bounds.bottom),
          items
        },
        (value) => {
          if (
            button.isConnected &&
            !button.matches(':disabled') &&
            latest.current.items.some((item) => item.value === value && !item.disabled)
          )
            latest.current.onSelect(value)
        }
      )
    } catch (error) {
      console.error('Could not open native menu', error)
    } finally {
      if (pending.current === request) {
        pending.current = null
        if (button.isConnected) {
          setOpen(false)
          if (!button.matches(':disabled') && document.hasFocus()) button.focus()
        }
      }
    }
  }

  return (
    <Button
      {...props}
      type="button"
      disabled={disabled}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(event) => void show(event.currentTarget)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault()
          void show(event.currentTarget)
        }
      }}
    />
  )
}
