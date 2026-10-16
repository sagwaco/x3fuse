import { LogicalPosition } from '@tauri-apps/api/dpi'
import { Menu } from '@tauri-apps/api/menu'
import type { NativeMenuItem, NativeMenuRequest } from '@shared/ipc'

type MenuItems = NonNullable<NonNullable<Parameters<typeof Menu.new>[0]>['items']>

let active: { id: string; valid: boolean } | undefined

/** Invalidation suppresses stale actions; the OS dismisses the visible popup. */
export function invalidateNativeMenu(id: string): void {
  if (active?.id === id) active.valid = false
}

export async function showNativeMenu(
  request: NativeMenuRequest,
  onSelect: (value: string) => void
): Promise<void> {
  if (active) active.valid = false
  const token = { id: request.id, valid: true }
  active = token
  let selected = false
  const options = (items: NativeMenuItem[]): MenuItems =>
    items.flatMap((item): MenuItems => [
      ...(item.separatorBefore ? [{ item: 'Separator' as const }] : []),
      item.items
        ? { text: item.label, enabled: !item.disabled, items: options(item.items) }
        : {
            text: item.label,
            enabled: !item.disabled,
            ...(item.checked === undefined ? {} : { checked: item.checked }),
            action: () => {
              if (token.valid && !selected && !item.disabled) {
                selected = true
                onSelect(item.value)
              }
            }
          }
    ])
  const menu = await Menu.new({ items: options(request.items) })
  try {
    if (token.valid) await menu.popup(new LogicalPosition(request.x, request.y))
  } finally {
    // Keep the token valid: queued selection callbacks may follow popup completion.
    await menu.close()
  }
}
