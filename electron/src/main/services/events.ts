import type { IpcEventChannel, IpcEventPayload } from '@shared/ipc'

/**
 * Sink for main->renderer events. ConversionService emits through this so it
 * stays decoupled from Electron: in the app it forwards to webContents.send
 * (M2), in the headless harness/tests it collects or ignores events.
 */
export interface EventSink {
  emit<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void
}

export const noopSink: EventSink = {
  emit() {
    /* no-op */
  }
}

/** Collects emitted events; handy for tests. */
export function createCollectingSink(): EventSink & {
  events: Array<{ channel: IpcEventChannel; payload: unknown }>
} {
  const events: Array<{ channel: IpcEventChannel; payload: unknown }> = []
  return {
    events,
    emit(channel, payload) {
      events.push({ channel, payload })
    }
  }
}
