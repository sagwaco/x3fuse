import type { MenuCommand } from '@shared/ipc'
import shortcuts from '@shared/shortcuts.json'
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

/** The keys of a command as Tauri accelerators, from `shortcuts.json`. Menus show the first. */
export function acceleratorsOf(name: MenuCommand): string[] {
  const keys = (shortcuts as Partial<Record<MenuCommand, string | string[]>>)[name]
  return keys === undefined ? [] : typeof keys === 'string' ? [keys] : keys
}
