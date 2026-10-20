import { LogicalPosition } from '@tauri-apps/api/dpi'
import { Menu } from '@tauri-apps/api/menu'
import type { Image } from '@tauri-apps/api/image'
import type { NativeMenuItem, NativeMenuRequest } from '@shared/ipc'
import { menuIcon } from './menuIcon'

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
  // A failed icon leaves a text-only item.
  const icons = new Map<NativeMenuItem, Image>()
  const loading: Promise<unknown>[] = []
  const load = (items: NativeMenuItem[]): void =>
    items.forEach((item) => {
      if (item.items) load(item.items)
      // Tauri decodes a submenu with an icon as a plain icon item, which loses its children.
      else if (item.icon && item.checked === undefined)
        loading.push(
          menuIcon(item.icon, !!item.disabled).then(
            (image) => icons.set(item, image),
            () => undefined
          )
        )
    })
  load(request.items)
  // Without icons, the menu opens in the same tick.
  if (loading.length) await Promise.all(loading)
  const options = (items: NativeMenuItem[]): MenuItems =>
    items.flatMap((item): MenuItems => [
      ...(item.separatorBefore ? [{ item: 'Separator' as const }] : []),
      item.items
        ? {
            text: item.label,
            enabled: !item.disabled,
            items: options(item.items)
          }
        : {
            text: item.label,
            enabled: !item.disabled,
            ...(item.accelerator ? { accelerator: item.accelerator } : {}),
            ...(item.checked === undefined ? {} : { checked: item.checked }),
            ...(icons.has(item) ? { icon: icons.get(item) } : {}),
            action: () => {
              if (token.valid && !selected && !item.disabled) {
                selected = true
                onSelect(item.value)
              }
            }
          }
    ])
  try {
    const menu = await Menu.new({ items: options(request.items) })
    try {
      if (token.valid) await menu.popup(new LogicalPosition(request.x, request.y))
    } finally {
      // Keep the token valid: queued selection callbacks may follow popup completion.
      await menu.close()
    }
  } finally {
    // The menu owns copies of the images by now, or it was never made.
    await Promise.all([...icons.values()].map((image) => image.close().catch(() => undefined)))
  }
}
