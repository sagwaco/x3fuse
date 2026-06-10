import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/ipc'
import type { Translate } from './i18n'

/**
 * Callbacks the native menu invokes. Queue/convert actions are dispatched to the
 * renderer as `menu:command` events (mirroring the Swift NotificationCenter bus);
 * window/log/update actions are handled directly in main.
 */
export interface MenuActions {
  send(name: MenuCommand): void
  openSettings(): void
  openLogs(): void
  clearLogs(): void
  checkForUpdates(): void
}

/**
 * Builds the application menu, porting MenuCommands.swift accelerators and
 * localizing the custom item labels (standard File/Edit/Window roles keep their
 * OS-provided labels).
 *
 * Note: queue-state-dependent enable/disable (Swift `.disabled(...)`) is not
 * replicated here — the renderer no-ops commands that don't apply. Backspace/
 * Delete removal is handled by the focused table in the renderer rather than a
 * global accelerator, so it never steals keystrokes from text fields.
 */
export function buildAppMenu(actions: MenuActions, t: Translate): void {
  const isMac = process.platform === 'darwin'
  const cmd = (name: MenuCommand) => (): void => actions.send(name)

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { label: t('updates.check_for_updates'), click: () => actions.checkForUpdates() },
              { type: 'separator' as const },
              {
                label: `${t('menu.file.settings')}…`,
                accelerator: 'Cmd+,',
                click: () => actions.openSettings()
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: `${t('menu.file.add_x3f_files')}`, accelerator: 'CmdOrCtrl+O', click: cmd('addFiles') },
        ...(isMac
          ? []
          : [
              { type: 'separator' as const },
              {
                label: `${t('menu.file.settings')}…`,
                accelerator: 'Ctrl+,',
                click: () => actions.openSettings()
              },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { label: t('menu.edit.select_all_files'), accelerator: 'CmdOrCtrl+A', click: cmd('selectAll') },
        {
          label: t('menu.edit.deselect_all_files'),
          accelerator: 'CmdOrCtrl+D',
          click: cmd('deselectAll')
        },
        { type: 'separator' },
        { label: t('menu.edit.remove_selected_files'), click: cmd('removeSelected') }
      ]
    },
    {
      label: t('menu.conversion.title'),
      submenu: [
        {
          label: t('menu.conversion.convert_all_files'),
          accelerator: 'CmdOrCtrl+R',
          click: cmd('convertAll')
        },
        {
          label: t('menu.conversion.stop_conversion'),
          accelerator: 'CmdOrCtrl+S',
          click: cmd('stop')
        },
        { type: 'separator' },
        {
          label: t('menu.conversion.clear_queue'),
          accelerator: 'CmdOrCtrl+K',
          click: cmd('clearQueue')
        },
        { type: 'separator' },
        { label: t('menu.conversion.remove_failed_files'), click: cmd('removeFailed') },
        { label: t('menu.conversion.remove_completed_files'), click: cmd('removeCompleted') }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: t('menu.help.X3Fuse_help'), click: () => {} },
        { type: 'separator' },
        {
          label: t('menu.help.show_debug_logs'),
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => actions.openLogs()
        },
        { label: t('menu.help.clear_debug_logs'), click: () => actions.clearLogs() }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
