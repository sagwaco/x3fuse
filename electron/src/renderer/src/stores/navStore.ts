import { create } from 'zustand'

/** Which top-level screen the main window is showing. */
export type Screen = 'queue' | 'export'

/**
 * Main-window screen routing. The Settings window is a separate BrowserWindow
 * (hash-routed in App), but inside the main window we switch between the queue
 * and the pre-conversion Export review screen with this tiny store. Keeping it
 * separate from the queue/settings stores means the deeply-nested Toolbar can
 * navigate without prop-drilling.
 */
interface NavState {
  screen: Screen
  goToExport: () => void
  goToQueue: () => void
}

export const useNavStore = create<NavState>((set) => ({
  screen: 'queue',
  goToExport: () => set({ screen: 'export' }),
  goToQueue: () => set({ screen: 'queue' })
}))
