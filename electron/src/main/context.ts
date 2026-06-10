import { app } from 'electron'
import { join } from 'path'
import { BinaryResolver } from './services/BinaryResolver'
import { ExifService } from './services/ExifService'
import { ConversionService } from './services/ConversionService'
import { PreviewService } from './services/PreviewService'
import { SettingsService } from './services/SettingsService'
import { LogService } from './services/LogService'
import { WebContentsSink } from './ipc/WebContentsSink'

/**
 * Composition root for the main process. Wires the conversion services to a
 * WebContentsSink that streams status/progress events to the renderer.
 */
export interface AppContext {
  resolver: BinaryResolver
  exif: ExifService
  conversion: ConversionService
  preview: PreviewService
  settings: SettingsService
  logs: LogService
  sink: WebContentsSink
}

export function createContext(): AppContext {
  // Packaged: extraResources land in process.resourcesPath. Dev: electron/resources
  // (out/main/index.js -> ../../resources).
  const resourcesRoot = app.isPackaged
    ? process.resourcesPath
    : join(__dirname, '../../resources')

  // LogService installs itself as the logger backend in its constructor.
  const logs = new LogService()
  const settings = new SettingsService()
  logs.setDebugEnabled(settings.get().debugLoggingEnabled)

  const sink = new WebContentsSink()
  const resolver = new BinaryResolver(resourcesRoot)
  const exif = new ExifService(resolver)
  const conversion = new ConversionService(resolver, exif, sink)
  const preview = new PreviewService(resolver)

  return { resolver, exif, conversion, preview, settings, logs, sink }
}
