import type { MenuCommand } from '@shared/ipc'
import shortcuts from '@shared/shortcuts.json'
import { appInfo } from './appInfo'

/** The keys of a command as Tauri accelerators, from `shortcuts.json`. Menus show the first. */
export function acceleratorsOf(name: MenuCommand): string[] {
  const keys = (shortcuts as Partial<Record<MenuCommand, string | string[]>>)[name]
  return keys === undefined ? [] : typeof keys === 'string' ? [keys] : keys
}

const SYMBOLS: Record<string, string> = {
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Slash: '/',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc'
}
/** Keys that macOS shows as a symbol. */
const MAC_SYMBOLS: Record<string, string> = { Enter: '↩', Backspace: '⌫', Shift: '⇧' }
/** The modifier symbols of macOS, in the order that macOS shows them. */
const MAC_MODIFIERS: [string, string][] = [
  ['Ctrl', '⌃'],
  ['Alt', '⌥'],
  ['Shift', '⇧'],
  ['CmdOrCtrl', '⌘']
]

/** An accelerator as the platform shows it: "⇧⌘E" on macOS, "Ctrl+Shift+E" elsewhere. */
export function formatAccelerator(accelerator: string): string {
  const parts = accelerator.split('+')
  const key = parts.pop()!
  if (appInfo.platform !== 'darwin')
    return [
      ...parts.map((part) => (part === 'CmdOrCtrl' ? 'Ctrl' : part)),
      SYMBOLS[key] ?? key
    ].join('+')
  const modifiers = MAC_MODIFIERS.filter(([name]) => parts.includes(name)).map(([, glyph]) => glyph)
  return modifiers.join('') + (MAC_SYMBOLS[key] ?? SYMBOLS[key] ?? key)
}

/** Adds the first key of a command to a tooltip, as in "Undo adjustment (⌘Z)". */
export function withShortcut(label: string, command: MenuCommand): string {
  const [accelerator] = acceleratorsOf(command)
  return accelerator ? `${label} (${formatAccelerator(accelerator)})` : label
}
