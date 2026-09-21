/** Shared command payloads and events for the renderer and Rust backend. */

import type {
  ConversionSettings,
  ConversionStatus,
  ExifPair,
  BatchConversionSettings,
  X3FFileDTO
} from './types'
import type { EditRecipe, EditRecord, EditorSession, RenderedPreview } from './editor'

/** A file the renderer asks main to act on (convert / existing-output check). */
export interface ConvertFile {
  id: string
  /** Absolute path to the source .X3F file. */
  path: string
  recipe?: EditRecipe
  sourceRevision?: string
  revision?: number
}

export interface BatchSummary {
  batchId: string
  cancelled: boolean
  completed: number
  failed: number
  warnings: number
  total: number
}

export interface OutputConflict {
  id: string
  outputPath: string
}

export interface LogSizes {
  conversion: number
  error: number
  debug: number
}

/** Commands fired by the native application menu. */
export type MenuCommand =
  | 'undoEdit'
  | 'redoEdit'
  | 'copyEdits'
  | 'pasteEdits'
  | 'addFiles'
  | 'selectAll'
  | 'deselectAll'
  | 'removeSelected'
  | 'convertAll'
  | 'stop'
  | 'clearQueue'
  | 'showLogs'
  | 'checkForUpdates'

export interface NativeMenuItem {
  value: string
  label: string
  disabled?: boolean
  checked?: boolean
  separatorBefore?: boolean
}

export interface NativeMenuRequest {
  id: string
  items: NativeMenuItem[]
  /** Anchor in renderer CSS pixels, relative to the window content. */
  x: number
  y: number
}

/** Request/response channels: channel -> { payload, result }. */
export interface IpcRequestMap {
  'editor:finishClose': { payload: { quit: boolean }; result: void }
  'editor:preview': {
    payload: { path: string; recipe: EditRecipe; revision: number; sourceRevision?: string }
    result: { url: string; sourceRevision: string }
  }
  'editor:cancelRender': { payload: { sessionId: string; revision: number }; result: void }
  'editor:beginImageRequest': { payload: void; result: { requestId: string } }
  'editor:endImageRequest': { payload: { requestId: string }; result: void }
  'editor:open': { payload: { path: string }; result: EditorSession }
  'editor:render': {
    payload: {
      sessionId: string
      recipe: EditRecipe
      revision: number
      maxEdge: number
      interactive?: boolean
      region?: { x: number; y: number; width: number; height: number }
    }
    result: RenderedPreview
  }
  'editor:save': {
    payload: { path: string; recipe: EditRecipe; revision: number; sourceRevision?: string }
    result: EditRecord
  }
  'editor:load': {
    payload: { paths: string[] }
    result: Array<{
      path: string
      recipe?: EditRecipe
      revision: number
      sourceRevision?: string
      storage?: EditRecord['storage']
      previewUrl?: string
      error?: string
    }>
  }
  'editor:close': { payload: { sessionId: string }; result: void }
  'editor:pickWhiteBalance': {
    payload: { sessionId: string; x: number; y: number; recipe?: EditRecipe }
    result: { temperature: number; tint: number }
  }
  'settings:get': { payload: void; result: ConversionSettings }
  'settings:set': { payload: Partial<ConversionSettings>; result: ConversionSettings }

  'queue:add': { payload: { paths: string[] }; result: X3FFileDTO[] }
  /** Returns the subset of ids whose computed output file already exists on disk. */
  'queue:existingOutputs': {
    payload: { files: ConvertFile[]; settings: BatchConversionSettings }
    result: OutputConflict[]
  }

  /** Convert a fixed batch using the supplied settings snapshot. */
  'convert:start': {
    payload: {
      batchId: string
      files: ConvertFile[]
      settings: BatchConversionSettings
      replaceExisting: boolean
      /** Exact conflicts displayed when replacement was confirmed; empty otherwise. */
      approvedOutputs: OutputConflict[]
    }
    result: void
  }
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

  'app:info': { payload: void; result: AppInfo }

  'update:check': { payload: void; result: void }
}

export type IpcRequestChannel = keyof IpcRequestMap
export type IpcPayload<C extends IpcRequestChannel> = IpcRequestMap[C]['payload']
export type IpcResult<C extends IpcRequestChannel> = IpcRequestMap[C]['result']

/** Main -> renderer event channels: channel -> payload. */
export interface IpcEventMap {
  'editor:closing': { quit: boolean }
  /** `outputPath` is set on the terminal `completed` status (used for reveal). */
  'batch:started': { batchId: string; settings: BatchConversionSettings }
  'file:status': {
    batchId: string
    id: string
    status: ConversionStatus
    message?: string
    outputPath?: string
  }
  'file:progress': { batchId: string; id: string; progress: number }
  'queue:overallProgress': { progress: number }
  'batch:complete': BatchSummary
  'update:available': { version: string }
  'update:downloaded': { version: string }
  'menu:command': { name: MenuCommand }
}

export type IpcEventChannel = keyof IpcEventMap
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventMap[C]

export const IPC_REQUEST_CHANNELS: IpcRequestChannel[] = [
  'editor:finishClose',
  'editor:preview',
  'editor:open',
  'editor:render',
  'editor:cancelRender',
  'editor:beginImageRequest',
  'editor:endImageRequest',
  'editor:save',
  'editor:load',
  'editor:close',
  'editor:pickWhiteBalance',
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
  'editor:closing',
  'batch:started',
  'file:status',
  'file:progress',
  'queue:overallProgress',
  'batch:complete',
  'update:available',
  'update:downloaded',
  'menu:command'
]

/** Typed application command and event adapter. */
export interface AppInfo {
  version: string
  platform: 'darwin' | 'win32' | 'linux'
  autoConcurrency: number
}

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
}
