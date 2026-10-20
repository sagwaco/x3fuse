import type { MenuCommand, NativeMenuItem } from '@shared/ipc'
import type { X3FFileDTO } from '@shared/types'
import { cull } from '../hooks/useCulling'
import { showNativeMenu } from './nativeMenu'
import { acceleratorsOf } from './shortcut'
import { t } from './strings'

/** A context menu item and what choosing it does. */
export type MenuAction = Omit<NativeMenuItem, 'items'> & { run: () => void; items?: MenuAction[] }

/** The key that menus show for a command, if it has one. */
export const keyOf = (name: MenuCommand): string | undefined => acceleratorsOf(name)[0]

/**
 * Shows a native context menu and runs the chosen action. `stale` returns true when the
 * menu no longer applies, as when another photo opened while it was open.
 */
export function showActions(
  id: string,
  x: number,
  y: number,
  actions: MenuAction[],
  stale?: () => boolean
): void {
  // A menu does not start with a separator.
  const items = (list: MenuAction[]): NativeMenuItem[] =>
    list.map(({ run: _run, items: children, separatorBefore, ...item }, index) => ({
      ...item,
      ...(index > 0 && separatorBefore && { separatorBefore }),
      ...(children && { items: items(children) })
    }))
  void showNativeMenu({ id, x, y, items: items(actions) }, (value) => {
    const action = actions
      // A disabled submenu does not open, so its items cannot be chosen.
      .flatMap((item): MenuAction[] =>
        item.items
          ? item.items.map((child) => ({ ...child, disabled: item.disabled || child.disabled }))
          : [item]
      )
      .find((item) => item.value === value)
    if (action && !action.disabled && !stale?.()) action.run()
  }).catch((error: unknown) => console.error('Could not open native context menu', error))
}

const FLAGS = [
  ['pick', 'pick'],
  ['reject', 'reject'],
  ['unflagged', 'unflag']
] as const

/** Set Flag and Set Rating submenus. They act on `files`, fixed when the menu opens. */
export function cullActions(files: X3FFileDTO[]): MenuAction[] {
  const ids = new Set(files.map((file) => file.id))
  const flags = new Set(files.map((file) => file.flag ?? 'unflagged'))
  const ratings = new Set(files.map((file) => file.rating ?? 0))
  return [
    {
      value: 'flag',
      label: t('filter.flag'),
      separatorBefore: true,
      run: () => {},
      items: FLAGS.map(([flag, command]) => ({
        value: `flag:${flag}`,
        label: t(`cull.${flag}`),
        accelerator: keyOf(command),
        checked: flags.size === 1 && flags.has(flag),
        run: () => cull({ flag }, { ids })
      }))
    },
    {
      value: 'rating',
      label: t('filter.rating'),
      run: () => {},
      items: ([0, 1, 2, 3, 4, 5] as const).map((rating) => ({
        value: `rating:${rating}`,
        label: rating ? '★'.repeat(rating) : t('cull.no_rating'),
        accelerator: keyOf(`rate${rating}`),
        checked: ratings.size === 1 && ratings.has(rating),
        run: () => cull({ rating }, { ids })
      }))
    }
  ]
}
