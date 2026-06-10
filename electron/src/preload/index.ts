import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  IPC_EVENT_CHANNELS,
  type IpcEventChannel,
  type IpcRequestChannel
} from '@shared/ipc'

/**
 * Minimal, safe bridge exposed on `window.x3f`. The renderer is fully typed
 * against `X3FBridge` (see index.d.ts); this implementation stays loosely typed
 * and validates event channel names against the shared allowlist.
 */
const bridge = {
  invoke(channel: IpcRequestChannel, payload?: unknown): Promise<unknown> {
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel: IpcEventChannel, listener: (payload: unknown) => void): () => void {
    if (!IPC_EVENT_CHANNELS.includes(channel)) {
      throw new Error(`x3f.on: unknown event channel "${channel}"`)
    }
    const subscription = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  },
  // Electron >=32 removed File.path; webUtils resolves it from the preload side.
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  }
}

contextBridge.exposeInMainWorld('x3f', bridge)
