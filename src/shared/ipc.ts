/** Shared command payloads and events for the renderer and Rust backend. */

import type { LucideIcon } from 'lucide-react'
import type {
  ConversionSettings,
  ConversionStatus,
  ExifPair,
  BatchConversionSettings,
  Flag,
  X3FFileDTO
} from './types'
import type { EditRecipe, EditRecord, EditorSession, RenderedPreview, X3iStatus } from './editor'

/** A file the renderer asks main to act on (convert / existing-output check). */
export interface ConvertFile {
  id: string
  /** Absolute path to the source .X3F file. */
  path: string
  settings?: BatchConversionSettings
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

/**
 * Commands of the menu bar, the keys, and the context menus. The menu item ids in
 * `menu.rs` and the keys of `shortcuts.json` use these names.
 */
export type MenuCommand =
  // File
  | 'addFiles'
  | 'addFolder'
  | 'editPhoto'
  | 'exportSelected'
  | 'exportPrevious'
  | 'exportJpeg'
  | 'exportTiff'
  | 'exportDng'
  | 'exportEmbeddedJpg'
  | 'convertAll'
  | 'stop'
  | 'showInFinder'
  | 'removeSelected'
  | 'clearQueue'
  // Edit
  | 'undoEdit'
  | 'redoEdit'
  | 'copyEdits'
  | 'pasteEdits'
  | 'resetEdits'
  | 'selectAll'
  | 'deselectAll'
  | 'invertSelection'
  // View
  | 'viewList'
  | 'viewGrid'
  | 'viewFilmstrip'
  | 'viewSurvey'
  | 'sortByName'
  | 'sortByDate'
  | 'sortBySize'
  | 'sortAscending'
  | 'sortDescending'
  | 'toggleFilterBar'
  | 'togglePanel'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'zoomActual'
  | 'compare'
  | 'negativePreview'
  // Photo
  | 'previousPhoto'
  | 'nextPhoto'
  | 'pick'
  | 'reject'
  | 'unflag'
  | 'rate0'
  | 'rate1'
  | 'rate2'
  | 'rate3'
  | 'rate4'
  | 'rate5'
  | 'ratingUp'
  | 'ratingDown'
  | 'rotateLeft'
  | 'rotateRight'
  | 'crop'
  | 'whiteBalancePicker'
  // Help
  | 'help'
  | 'shortcuts'
  | 'showLogs'
  | 'checkForUpdates'

/** How a command started. Keys toggle flags; Shift with a key also advances. */
export interface CommandOptions {
  source?: 'menu' | 'key' | 'context'
  advance?: boolean
  toggle?: boolean
}

export interface NativeMenuItem {
  value: string
  label: string
  disabled?: boolean
  checked?: boolean
  /** Drawn before the label. A checked item shows its check mark instead. */
  icon?: LucideIcon
  separatorBefore?: boolean
  /** Items of a submenu. A submenu item is not selected itself. */
  items?: NativeMenuItem[]
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
    /** Without `recipe`, the backend renders the photo's camera defaults. */
    payload: { path: string; recipe?: EditRecipe; revision: number; sourceRevision?: string }
    result: { url: string; sourceRevision: string }
  }
  'editor:cancelRender': { payload: { sessionId: string; revision: number }; result: void }
  'editor:beginImageRequest': { payload: void; result: { requestId: string } }
  'editor:endImageRequest': { payload: { requestId: string }; result: void }
  'editor:open': { payload: { path: string }; result: EditorSession }
  'editor:warm': { payload: { path: string }; result: void }
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
  /** Null for a photo that is not an X3I. The recipe selects the denoise. */
  'editor:x3iStatus': { payload: { path: string; recipe: EditRecipe }; result: X3iStatus | null }
  /** Resolves when the merge ends. */
  'editor:x3iProcess': { payload: { path: string; recipe: EditRecipe }; result: void }
  'editor:x3iCancel': { payload: { path: string }; result: void }
  /** Removes the cached merged image. */
  'editor:x3iDelete': { payload: { path: string; recipe: EditRecipe }; result: void }
  'settings:get': { payload: void; result: ConversionSettings }
  'settings:set': { payload: Partial<ConversionSettings>; result: ConversionSettings }

  'queue:add': { payload: { paths: string[] }; result: X3FFileDTO[] }
  /** Save a flag and/or rating for photos. Originals are never changed. */
  'culling:set': { payload: { paths: string[]; flag?: Flag; rating?: number }; result: void }
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
  /** The X3F and X3I files in the chosen folders, without subfolders. */
  'dialog:pickFolder': { payload: void; result: string[] }
  'dialog:pickOutputDir': { payload: void; result: string | null }

  /** Reveal a path in the OS file manager (Finder / Explorer / file-manager). */
  'shell:reveal': { payload: { path: string }; result: void }

  'window:openSettings': { payload: void; result: void }

  'logs:open': { payload: void; result: void }
  /** Open the bundled third-party licence notices in the OS file manager. */
  'licenses:open': { payload: void; result: void }
  'logs:clear': { payload: void; result: void }
  'logs:sizes': { payload: void; result: LogSizes }
  /** Bytes in the preview disk cache. */
  'cache:size': { payload: void; result: number }
  /** Removes the preview disk cache. The previews in memory stay. */
  'cache:clear': { payload: void; result: void }

  'app:info': { payload: void; result: AppInfo }
  /** Trackpad click as a slider drag reaches a detent (macOS only). */
  'haptics:detent': { payload: void; result: void }

  'update:check': { payload: { manual: boolean }; result: void }
}

export type IpcRequestChannel = keyof IpcRequestMap
export type IpcPayload<C extends IpcRequestChannel> = IpcRequestMap[C]['payload']
export type IpcResult<C extends IpcRequestChannel> = IpcRequestMap[C]['result']

/** Main -> renderer event channels: channel -> payload. */
export interface IpcEventMap {
  'settings:changed': null
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
  'editor:warm',
  'editor:render',
  'editor:cancelRender',
  'editor:beginImageRequest',
  'editor:endImageRequest',
  'editor:save',
  'editor:load',
  'editor:close',
  'editor:pickWhiteBalance',
  'editor:x3iStatus',
  'editor:x3iProcess',
  'editor:x3iCancel',
  'editor:x3iDelete',
  'settings:get',
  'settings:set',
  'queue:add',
  'culling:set',
  'queue:existingOutputs',
  'convert:start',
  'convert:stop',
  'exif:full',
  'dialog:pickFiles',
  'dialog:pickFolder',
  'dialog:pickOutputDir',
  'shell:reveal',
  'window:openSettings',
  'logs:open',
  'licenses:open',
  'logs:clear',
  'logs:sizes',
  'cache:size',
  'cache:clear',
  'app:info',
  'haptics:detent',
  'update:check'
]

export const IPC_EVENT_CHANNELS: IpcEventChannel[] = [
  'settings:changed',
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
