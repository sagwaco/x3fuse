import { app, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { existsSync } from 'fs'
import type { IpcPayload, IpcRequestChannel, IpcResult } from '@shared/ipc'
import type { AppContext } from '../context'
import type { WindowManager } from '../windows'
import type { Translate } from '../i18n'
import { buildFileDTO, outputFilePath } from '../services/queueHelpers'

type Handler<C extends IpcRequestChannel> = (
  payload: IpcPayload<C>
) => IpcResult<C> | Promise<IpcResult<C>>

function handle<C extends IpcRequestChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, (_event, payload) => handler(payload as IpcPayload<C>))
}

/** Registers all request/response IPC handlers. */
export function registerIpcHandlers(
  ctx: AppContext,
  windows: WindowManager,
  t: Translate
): void {
  // --- Settings ---
  handle('settings:get', () => ctx.settings.get())
  handle('settings:set', (patch) => {
    const next = ctx.settings.set(patch)
    ctx.logs.setDebugEnabled(next.debugLoggingEnabled)
    return next
  })

  // --- Queue ---
  handle('queue:add', async ({ paths }) => {
    const x3f = paths.filter((p) => p.toLowerCase().endsWith('.x3f'))
    const [dtos, meta] = await Promise.all([
      Promise.all(x3f.map(buildFileDTO)),
      ctx.exif.displayMeta(x3f)
    ])
    for (const dto of dtos) {
      const m = meta.get(dto.path)
      if (!m) continue
      if (m.orientation && m.orientation !== 1) dto.orientation = m.orientation
      if (m.aspectRatio && m.aspectRatio > 0) dto.aspectRatio = m.aspectRatio
    }
    return dtos
  })

  handle('queue:existingOutputs', ({ files }) => {
    const settings = ctx.settings.get()
    return files
      .filter((f) => existsSync(outputFilePath(settings, f.path, f.overrides)))
      .map((f) => f.id)
  })

  // --- Conversion ---
  handle('convert:start', async ({ files }) => {
    const settings = ctx.settings.get()
    await ctx.conversion.convert(files, settings)
  })
  handle('convert:stop', () => ctx.conversion.stop())

  // --- EXIF (inspector panel) ---
  handle('exif:full', ({ path }) => ctx.exif.fullMetadata(path))

  // --- Dialogs ---
  handle('dialog:pickFiles', async () => {
    const win = windows.getMain()
    const options: OpenDialogOptions = {
      title: t('dialog.select_x3f_files.title'),
      message: t('dialog.select_x3f_files.message'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'X3F RAW', extensions: ['x3f', 'X3F'] }]
    }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return res.canceled ? [] : res.filePaths
  })

  handle('dialog:pickOutputDir', async () => {
    const win = windows.getMain()
    const options: OpenDialogOptions = {
      title: t('dialog.select_output_directory.title'),
      message: t('dialog.select_output_directory.message'),
      properties: ['openDirectory', 'createDirectory']
    }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // --- Shell ---
  handle('shell:reveal', ({ path }) => {
    shell.showItemInFolder(path)
  })

  // --- Windows ---
  handle('window:openSettings', () => {
    windows.openSettings()
  })

  // --- Logs ---
  handle('logs:open', () => ctx.logs.openDir())
  handle('logs:clear', () => ctx.logs.clear())
  handle('logs:sizes', () => ctx.logs.sizes())

  // --- App ---
  handle('app:info', () => ({ version: app.getVersion() }))

  // --- Updates (M4) ---
  handle('update:check', () => {
    /* M4 */
  })
}
