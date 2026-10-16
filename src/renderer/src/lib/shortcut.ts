import { appInfo } from './appInfo'

/**
 * Adds a keyboard shortcut to a tooltip, as in "Undo (⌘Z)". Write `Mod+` for ⌘ on macOS
 * and Ctrl elsewhere, and put `Shift+` after it.
 */
export function withShortcut(label: string, keys: string): string {
  const shown =
    appInfo.platform === 'darwin'
      ? keys.replace('Mod+Shift+', '⇧⌘').replace('Mod+', '⌘')
      : keys.replace('Mod+', 'Ctrl+')
  return `${label} (${shown})`
}
