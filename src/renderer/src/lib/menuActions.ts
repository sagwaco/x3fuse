import type { MenuCommand, NativeMenuItem } from '@shared/ipc'
import type { X3FFileDTO } from '@shared/types'
import { cull } from '../hooks/useCulling'
import { appInfo } from './appInfo'
import { showNativeMenu } from './nativeMenu'
import { acceleratorsOf } from './shortcut'
import { t } from './strings'

/** A context menu item and what choosing it does. */
export type MenuAction = Omit<NativeMenuItem, 'items'> & { run: () => void; items?: MenuAction[] }

/** The key that menus show for a command, if it has one. */
export const keyOf = (name: MenuCommand): string | undefined => acceleratorsOf(name)[0]

/** The text of the menu bar items with keys, as `menu.rs` sets it. */
const LABELS: Partial<Record<MenuCommand, string>> = {
  addFiles: 'menu.file.add_photos',
  addFolder: 'menu.file.add_folder',
  editPhoto: 'menu.file.edit_photo',
  exportSelected: 'menu.file.export',
  exportPrevious: 'batch.convert_previous',
  stop: 'menu.file.stop_export',
  clearQueue: 'menu.file.clear_queue',
  undoEdit: 'menu.edit.undo',
  redoEdit: 'menu.edit.redo',
  copyEdits: 'menu.edit.copy_adjustments',
  pasteEdits: 'menu.edit.paste_adjustments',
  resetEdits: 'menu.edit.reset_adjustments',
  selectAll: 'menu.edit.select_all',
  deselectAll: 'context.deselect_all',
  viewGrid: 'menu.view.grid',
  viewFilmstrip: 'menu.view.filmstrip',
  viewSurvey: 'menu.view.survey',
  toggleFilterBar: 'menu.view.filter_bar',
  togglePanel: 'menu.view.info_panel',
  zoomIn: 'menu.view.zoom_in',
  zoomOut: 'menu.view.zoom_out',
  zoomFit: 'menu.view.zoom_fit',
  zoomActual: 'menu.view.actual_size',
  compare: 'editor.compare',
  previousPhoto: 'menu.photo.previous',
  nextPhoto: 'menu.photo.next',
  pick: 'cull.pick',
  reject: 'cull.reject',
  unflag: 'cull.unflagged',
  rate0: 'menu.photo.no_rating',
  ratingUp: 'menu.photo.increase_rating',
  ratingDown: 'menu.photo.decrease_rating',
  rotateLeft: 'menu.photo.rotate_left',
  rotateRight: 'menu.photo.rotate_right',
  crop: 'editor.crop',
  whiteBalancePicker: 'menu.photo.white_balance_picker',
  shortcuts: 'menu.help.keyboard_shortcuts',
  showLogs: 'menu.help.show_debug_logs'
}

/** The text of a command in the menu bar. Context menus and the shortcut sheet use it too. */
export function labelOf(name: MenuCommand): string {
  if (name === 'showInFinder')
    return t(
      appInfo.platform === 'darwin'
        ? 'context.show_in_finder'
        : appInfo.platform === 'win32'
          ? 'menu.file.show_in_explorer'
          : 'menu.file.show_in_file_manager'
    )
  const rating = /^rate([1-5])$/.exec(name)
  return rating ? '★'.repeat(Number(rating[1])) : t(LABELS[name] ?? name)
}

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
      label: t('menu.photo.set_flag'),
      separatorBefore: true,
      run: () => {},
      items: FLAGS.map(([flag, command]) => ({
        value: `flag:${flag}`,
        label: labelOf(command),
        accelerator: keyOf(command),
        checked: flags.size === 1 && flags.has(flag),
        run: () => cull({ flag }, { ids })
      }))
    },
    {
      value: 'rating',
      label: t('menu.photo.set_rating'),
      run: () => {},
      items: ([0, 1, 2, 3, 4, 5] as const).map((rating) => ({
        value: `rating:${rating}`,
        label: labelOf(`rate${rating}`),
        accelerator: keyOf(`rate${rating}`),
        checked: ratings.size === 1 && ratings.has(rating),
        run: () => cull({ rating }, { ids })
      }))
    }
  ]
}
