import { create } from 'zustand'
import { DEFAULT_SETTINGS, type ConversionSettings } from '@shared/types'
import { ipc } from '../lib/ipc'

/**
 * Renderer mirror of the authoritative main-process settings (SettingsService).
 * `update` is optimistic and reconciles with the value main returns. Conversion
 * always reads settings from main, so a brief mismatch is display-only.
 */
interface SettingsState {
  settings: ConversionSettings
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<ConversionSettings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,

  async load() {
    const settings = await ipc.invoke('settings:get')
    set({ settings, loaded: true })
  },

  async update(patch) {
    // Optimistic: reflect locally, then reconcile with main's authoritative copy.
    set({ settings: { ...get().settings, ...patch } })
    const settings = await ipc.invoke('settings:set', patch)
    set({ settings })
  }
}))
