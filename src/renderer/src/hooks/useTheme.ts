import { useSyncExternalStore } from 'react'
import type { ThemeName } from '@shared/types'

function subscribe(change: () => void): () => void {
  const observer = new MutationObserver(change)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

const read = (): ThemeName => (document.documentElement.dataset.theme as ThemeName) || 'dark'

/** The theme on the document (see applyTheme). It changes with the settings and the system. */
export function useTheme(): ThemeName {
  return useSyncExternalStore(subscribe, read)
}
