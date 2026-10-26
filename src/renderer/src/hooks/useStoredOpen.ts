import { useState } from 'react'

/** Local storage key for the open state of each editor section, by section id. */
const KEY = 'x3fuse.sections'

// Storage can be absent or throw, for example in a locked-down webview.
function stored(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}

/**
 * The open state of a section. It is read at mount and is `initial` when nothing is stored.
 * Without an id, the section starts closed and nothing is stored.
 */
export function useStoredOpen(id?: string, initial = true): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => (id ? (stored()[id] ?? initial) : false))
  const save = (next: boolean): void => {
    // A section that mounts open also fires a toggle event. It changes nothing.
    if (next === open) return
    setOpen(next)
    if (!id) return
    try {
      // Read the map again, so the other sections keep their states.
      localStorage.setItem(KEY, JSON.stringify({ ...stored(), [id]: next }))
    } catch {
      // Without storage, the state lasts until the section unmounts.
    }
  }
  return [open, save]
}
