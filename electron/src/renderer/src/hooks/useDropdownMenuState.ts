import { useEffect, useState } from 'react'

/** Radix handles DOM interactions; also dismiss when the native window changes. */
export function useDropdownMenuState() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const dismiss = (): void => setOpen(false)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  return [open, setOpen] as const
}
