import Store from 'electron-store'
import { normalizeSettings } from '@shared/settingsMigration'
import type { ConversionSettings } from '@shared/types'

/**
 * Authoritative settings store (main process), persisted to a JSON file via
 * electron-store (replacing UserDefaults). On load and on every write the value
 * is run through `normalizeSettings`, which applies the legacy migrations
 * (int-enum -> string union, denoise bool -> intensity, clamp). The on-disk file
 * is rewritten in normalized form so old shapes are upgraded once.
 */
export class SettingsService {
  private readonly store: Store<Record<string, unknown>>
  private settings: ConversionSettings

  constructor() {
    this.store = new Store<Record<string, unknown>>({ name: 'settings' })
    this.settings = normalizeSettings(this.store.store)
    this.persist()
  }

  get(): ConversionSettings {
    return { ...this.settings }
  }

  set(patch: Partial<ConversionSettings>): ConversionSettings {
    this.settings = normalizeSettings({ ...this.settings, ...patch })
    this.persist()
    return this.get()
  }

  private persist(): void {
    this.store.store = this.settings as unknown as Record<string, unknown>
  }
}
