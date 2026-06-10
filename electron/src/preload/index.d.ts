import type { X3FBridge } from '@shared/ipc'

declare global {
  interface Window {
    x3f: X3FBridge
  }
}

export {}
