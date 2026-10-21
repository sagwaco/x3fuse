import { useEffect } from 'react'
import type { MenuCommand } from '@shared/ipc'
import shortcuts from '@shared/shortcuts.json'
import { appInfo } from '../lib/appInfo'
import { runCommand } from '../lib/commands'
import { acceleratorsOf } from '../lib/shortcut'
import { isTextEditing } from '../stores/editorStore'

interface Binding {
  name: MenuCommand
  key: string
  mod: boolean
  alt: boolean
  shift: boolean
}

/** Every key of every command in `shortcuts.json`. */
const BINDINGS: Binding[] = (Object.keys(shortcuts) as MenuCommand[]).flatMap((name) =>
  acceleratorsOf(name).map((accelerator) => {
    const parts = accelerator.split('+')
    return {
      name,
      key: parts.at(-1)!,
      mod: parts.includes('CmdOrCtrl'),
      alt: parts.includes('Alt'),
      shift: parts.includes('Shift')
    }
  })
)
const CHARACTERS: Record<string, string> = {
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Slash: '/'
}
const FLAGS = new Set<MenuCommand>(['pick', 'reject', 'unflag'])
/** Shift with these keys also moves to the next photo. */
const ADVANCE = new Set<MenuCommand>([
  ...FLAGS,
  'rate0',
  'rate1',
  'rate2',
  'rate3',
  'rate4',
  'rate5'
])
/** Commands that run again while their key is held. Other held keys do nothing. */
const REPEAT = new Set<MenuCommand>(['zoomIn', 'zoomOut', 'previousPhoto', 'nextPhoto'])
/** Commands that run before the focused control gets the key, as a slider takes arrow keys. */
const EARLY = new Set<MenuCommand>(['previousPhoto', 'nextPhoto'])
const POPUP_OPEN =
  '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [aria-haspopup="menu"][aria-expanded="true"]'

/** True when the event has the key of an accelerator, whatever the modifiers. */
function sameKey(key: string, alt: boolean, event: KeyboardEvent): boolean {
  // Digits match the physical key of the main row or the keypad, so that Shift can advance.
  if (/^\d$/.test(key)) return event.code === `Digit${key}` || event.code === `Numpad${key}`
  // Option changes the character on macOS, so with Alt the physical key matches.
  if (alt) return event.code === (/^[A-Z]$/.test(key) ? `Key${key}` : key)
  // Menus show the character of the key on the current layout. Match the same character.
  return event.key.toLowerCase() === (CHARACTERS[key] ?? key).toLowerCase()
}

/** The commands whose keys the event has, in the order of `shortcuts.json`. */
function commandsOf(event: KeyboardEvent): MenuCommand[] {
  const mac = appInfo.platform === 'darwin'
  // CmdOrCtrl is Command on macOS and Control elsewhere. The other one is not a shortcut.
  const mod = mac ? event.metaKey : event.ctrlKey
  if (mac ? event.ctrlKey : event.metaKey) return []
  return BINDINGS.filter(
    (binding) =>
      binding.mod === mod &&
      binding.alt === event.altKey &&
      (binding.shift === event.shiftKey || (event.shiftKey && ADVANCE.has(binding.name))) &&
      sameKey(binding.key, binding.alt, event)
  ).map((binding) => binding.name)
}

/**
 * True for the keys that a text field uses itself: keys without ⌘ (Ctrl on Windows and
 * Linux), ⌘A, ⌘C, ⌘V, ⌘X, ⌘Z, ⇧⌘Z, and the arrow keys with any modifier.
 */
function fieldKey(event: KeyboardEvent): boolean {
  const mod = appInfo.platform === 'darwin' ? event.metaKey : event.ctrlKey
  // AltGr types characters on Windows, and it also sets Ctrl and Alt.
  if (!mod || event.key.startsWith('Arrow') || event.getModifierState('AltGraph')) return true
  const key = event.key.toLowerCase()
  return !event.altKey && (event.shiftKey ? key === 'z' : /^[acvxz]$/.test(key))
}

/**
 * Runs the commands of `shortcuts.json` from the keyboard. A key prevents its default
 * action only when its command ran. On macOS a key that the page does not use then goes
 * to the menu bar. Open dialogs and menus and an IME keep their keys. Text fields keep
 * the keys that they use; other shortcuts run and never reach the menu bar, as in a Mac
 * app. Focused controls use their keys first, such as the arrow keys of a list or `+` on
 * a preview. Only ⌘← and ⌘→ go to the photos before the focused control.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const listener =
      (early: boolean) =>
      (event: KeyboardEvent): void => {
        const text = isTextEditing(event.target)
        if (
          event.defaultPrevented ||
          event.isComposing ||
          (text && fieldKey(event)) ||
          document.querySelector(POPUP_OPEN)
        )
          return
        // Return opens a photo only from the page itself. A focused control uses it.
        // The list and the grid send it from their own key handlers.
        if (event.key === 'Enter' && event.target !== document.body) return
        const names = commandsOf(event).filter((name) => EARLY.has(name) === early)
        if (!names.length) return
        // A held key must not reach a menu item either. In a text field no shortcut does.
        if (text) event.preventDefault()
        const run = event.repeat ? names.filter((name) => REPEAT.has(name)) : names
        if (!run.length) return event.preventDefault()
        for (const name of run) {
          const options = {
            source: 'key' as const,
            advance: event.shiftKey && ADVANCE.has(name),
            toggle: FLAGS.has(name)
          }
          if (runCommand(name, options)) {
            event.preventDefault()
            if (early) event.stopPropagation()
            return
          }
        }
      }
    const early = listener(true)
    const late = listener(false)
    window.addEventListener('keydown', early, true)
    document.addEventListener('keydown', late)
    return () => {
      window.removeEventListener('keydown', early, true)
      document.removeEventListener('keydown', late)
    }
  }, [])
}
