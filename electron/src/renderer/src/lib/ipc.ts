import type { X3FBridge } from '@shared/ipc'

/**
 * Typed entry point to the main process. The renderer always goes through this
 * wrapper and never touches a raw channel string. Backed by the preload bridge
 * exposed on `window.x3f` (see src/preload/index.ts).
 */
export const ipc: X3FBridge = window.x3f
