import type { WebContents } from 'electron'
import type { IpcEventChannel, IpcEventPayload } from '@shared/ipc'
import type { EventSink } from '../services/events'

/**
 * EventSink implementation that forwards main->renderer events to a target
 * WebContents (the main window). The headless harness/tests use the collecting
 * sink instead; this is the production wiring.
 */
export class WebContentsSink implements EventSink {
  private target: WebContents | null = null

  attach(wc: WebContents): void {
    this.target = wc
  }

  detach(wc: WebContents): void {
    if (this.target === wc) this.target = null
  }

  emit<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(channel, payload)
    }
  }
}
