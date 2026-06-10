/**
 * Typed IPC contract — the single source of truth for every channel between
 * the main and renderer processes. Imported by main (to type handlers),
 * preload (to type the bridge), and renderer (to type calls).
 *
 * Two directions:
 *   - Request/response  (ipcRenderer.invoke / ipcMain.handle)  -> IpcRequestMap
 *   - Events main->renderer (webContents.send / ipcRenderer.on) -> IpcEventMap
 *
 * The renderer never references a raw channel string; it goes through the
 * `window.x3f` bridge (see preload) which is fully typed by `X3FBridge`.
 *
 * Architecture note: the renderer owns the queue (queueStore) and decides which
 * files to convert; the main process is stateless about the queue and simply
 * executes the file list it is handed, reading global options from
 * SettingsService. Status/progress flow back as events keyed by file id.
 */

import type {
  ConversionSettings,
  ConversionStatus,
  ExifPair,
  FileOverrides,
  X3FFileDTO
} from './types'

/** A file the renderer asks main to act on (convert / existing-output check). */
export interface ConvertFile {
  id: string
  /** Absolute path to the source .X3F file. */
  path: string
  overrides?: FileOverrides
}

export interface BatchSummary {
  completed: number
  failed: number
  warnings: number
  total: number
}

export interface LogSizes {
  conversion: number
  error: number
  debug: number
}

/** Commands fired by the native application menu (mirrors Swift NotificationCenter bus). */
export type MenuCommand =
  | 'addFiles'
  | 'selectAll'
  | 'deselectAll'
  | 'removeSelected'
  | 'convertAll'
  | 'stop'
  | 'clearQueue'
  | 'removeFailed'
  | 'removeCompleted'
  | 'showLogs'
  | 'checkForUpdates'

/** Request/response channels: channel -> { payload, result }. */
export interface IpcRequestMap {
  'settings:get': { payload: void; result: ConversionSettings }
  'settings:set': { payload: Partial<ConversionSettings>; result: ConversionSettings }

  'queue:add': { payload: { paths: string[] }; result: X3FFileDTO[] }
  /** Returns the subset of ids whose computed output file already exists on disk. */
  'queue:existingOutputs': { payload: { files: ConvertFile[] }; result: string[] }

  /** Convert the given files sequentially. Global options come from SettingsService. */
  'convert:start': { payload: { files: ConvertFile[] }; result: void }
  'convert:stop': { payload: void; result: void }

  /** Full, display-ready EXIF for the inspector panel (curated, ordered). */
  'exif:full': { payload: { path: string }; result: ExifPair[] }

  'dialog:pickFiles': { payload: void; result: string[] }
  'dialog:pickOutputDir': { payload: void; result: string | null }

  /** Reveal a path in the OS file manager (Finder / Explorer / file-manager). */
  'shell:reveal': { payload: { path: string }; result: void }

  'window:openSettings': { payload: void; result: void }

  'logs:open': { payload: void; result: void }
  'logs:clear': { payload: void; result: void }
  'logs:sizes': { payload: void; result: LogSizes }

  'app:info': { payload: void; result: { version: string } }

  'update:check': { payload: void; result: void }
}

export type IpcRequestChannel = keyof IpcRequestMap
export type IpcPayload<C extends IpcRequestChannel> = IpcRequestMap[C]['payload']
export type IpcResult<C extends IpcRequestChannel> = IpcRequestMap[C]['result']

/** Main -> renderer event channels: channel -> payload. */
export interface IpcEventMap {
  /** `outputPath` is set on the terminal `completed` status (used for reveal). */
  'file:status': {
    id: string
    status: ConversionStatus
    message?: string
    outputPath?: string
  }
  'file:progress': { id: string; progress: number }
  'queue:overallProgress': { progress: number }
  'batch:complete': BatchSummary
  'update:available': { version: string }
  'update:downloaded': { version: string }
  'menu:command': { name: MenuCommand }
}

export type IpcEventChannel = keyof IpcEventMap
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventMap[C]

export const IPC_REQUEST_CHANNELS: IpcRequestChannel[] = [
  'settings:get',
  'settings:set',
  'queue:add',
  'queue:existingOutputs',
  'convert:start',
  'convert:stop',
  'exif:full',
  'dialog:pickFiles',
  'dialog:pickOutputDir',
  'shell:reveal',
  'window:openSettings',
  'logs:open',
  'logs:clear',
  'logs:sizes',
  'app:info',
  'update:check'
]

export const IPC_EVENT_CHANNELS: IpcEventChannel[] = [
  'file:status',
  'file:progress',
  'queue:overallProgress',
  'batch:complete',
  'update:available',
  'update:downloaded',
  'menu:command'
]

/** The API surface exposed on `window.x3f` by the preload bridge. */
export interface X3FBridge {
  invoke<C extends IpcRequestChannel>(
    channel: C,
    ...args: IpcPayload<C> extends void ? [] : [payload: IpcPayload<C>]
  ): Promise<IpcResult<C>>
  /** Subscribe to a main->renderer event. Returns an unsubscribe function. */
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void
  ): () => void
  /**
   * Resolve the absolute filesystem path of a dropped `File`. Electron >=32
   * removed `File.path`; this wraps `webUtils.getPathForFile` from the preload.
   */
  pathForFile(file: File): string
}
