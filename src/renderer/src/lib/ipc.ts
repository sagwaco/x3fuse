import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  IPC_EVENT_CHANNELS,
  type IpcEventChannel,
  type IpcEventMap,
  type IpcPayload,
  type IpcRequestChannel,
  type IpcResult,
  type X3FBridge
} from '@shared/ipc'

const listeners = new Map<IpcEventChannel, Set<(payload: never) => void>>()
let ready: Promise<void> | undefined
let subscriptions: UnlistenFn[] = []

/** Install the native listeners before mounting React or accepting exports. */
export function initializeIpc(): Promise<void> {
  ready ??= Promise.allSettled(
    IPC_EVENT_CHANNELS.map((channel) =>
      listen<IpcEventMap[typeof channel]>(channel, ({ payload }) => {
        listeners.get(channel)?.forEach((listener) => listener(payload as never))
      })
    )
  )
    .then((results) => {
      subscriptions = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      )
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })
    .catch((error: unknown) => {
      subscriptions.forEach((off) => off())
      subscriptions = []
      ready = undefined
      throw error
    })
  return ready
}

export const commandName = (channel: IpcRequestChannel): string =>
  channel.replace(':', '_').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

export const ipc: X3FBridge = {
  invoke<C extends IpcRequestChannel>(
    channel: C,
    ...args: IpcPayload<C> extends void ? [] : [payload: IpcPayload<C>]
  ): Promise<IpcResult<C>> {
    return invoke<IpcResult<C>>(commandName(channel), args.length ? { payload: args[0] } : {})
  },
  on(channel, listener) {
    let handlers = listeners.get(channel)
    if (!handlers) listeners.set(channel, (handlers = new Set()))
    const handler = listener as (payload: never) => void
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    subscriptions.forEach((off) => off())
    listeners.clear()
  })
}
