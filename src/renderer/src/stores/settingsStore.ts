import { create } from 'zustand'
import { DEFAULT_SETTINGS, type ConversionSettings } from '@shared/types'
import { ipc } from '../lib/ipc'

/** Immediate UI preferences with ordered, atomic backend saves. */
interface SettingsState {
  settings: ConversionSettings
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<ConversionSettings>) => Promise<void>
  accept: (patch: Partial<ConversionSettings>) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  type Change = { patch: Partial<ConversionSettings>; revision: number; finish: () => void }
  const pending: Change[] = []
  let saved = { ...DEFAULT_SETTINGS }
  let revision = 0
  let loadId = 0
  let saving = false
  const acceptedAt: Partial<Record<keyof ConversionSettings, number>> = {}

  function currentPatch(change: Change): Partial<ConversionSettings> {
    return Object.fromEntries(
      (Object.keys(change.patch) as Array<keyof ConversionSettings>)
        .filter((key) => (acceptedAt[key] ?? 0) <= change.revision)
        .map((key) => [key, change.patch[key]])
    )
  }

  function publish(): void {
    set({ settings: Object.assign({}, saved, ...pending.map(currentPatch)) })
  }

  async function save(): Promise<void> {
    saving = true
    while (pending.length) {
      const change = pending[0]
      try {
        const patch = currentPatch(change)
        const settings = Object.keys(patch).length ? await ipc.invoke('settings:set', patch) : saved
        // Batch-start events can confirm newer settings before this response
        // arrives. Keep those fields while accepting the backend snapshot.
        const newer = Object.fromEntries(
          (Object.keys(acceptedAt) as Array<keyof ConversionSettings>)
            .filter((key) => acceptedAt[key]! > change.revision)
            .map((key) => [key, saved[key]])
        )
        saved = { ...settings, ...newer }
        set({ loaded: true })
      } catch (error) {
        console.error('Could not save settings', error)
      }
      pending.shift()
      publish()
      change.finish()
    }
    saving = false
  }

  return {
    settings: { ...DEFAULT_SETTINGS },
    loaded: false,

    async load() {
      if (pending.length) return
      const currentLoad = ++loadId
      const currentRevision = revision
      try {
        const settings = await ipc.invoke('settings:get')
        if (currentLoad !== loadId || currentRevision !== revision) return
        saved = settings
        set({ settings, loaded: true })
      } catch (error) {
        console.error('Could not load settings', error)
      }
    },

    update(patch) {
      if (!pending.length) saved = get().settings
      const promise = new Promise<void>((finish) => {
        pending.push({ patch: { ...patch }, revision: ++revision, finish })
      })
      publish()
      if (!saving) void save()
      return promise
    },

    accept(patch) {
      if (!pending.length) saved = get().settings
      ++revision
      for (const key of Object.keys(patch) as Array<keyof ConversionSettings>) {
        acceptedAt[key] = revision
      }
      saved = { ...saved, ...patch }
      publish()
    }
  }
})
