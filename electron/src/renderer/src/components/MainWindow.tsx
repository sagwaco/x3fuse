import { useEffect } from 'react'
import type { QueueViewMode } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useIpcEvents } from '../hooks/useIpcEvents'
import { Toolbar } from './Toolbar'
import { Footer } from './Footer'
import { DropZone } from './DropZone'
import { FileQueue } from './FileQueue'
import { FileGrid } from './FileGrid'
import { FileFilmstrip } from './FileFilmstrip'
import { Inspector } from './Inspector'
import { ReconversionDialog } from './ReconversionDialog'

/** The conversion-queue window (port of ContentView). */
export function MainWindow(): React.JSX.Element {
  const hasFiles = useQueueStore((s) => s.files.length > 0)
  const viewMode = useSettingsStore((s) => s.settings.queueViewMode)
  const inspectorOpen = useSettingsStore((s) => s.settings.inspectorOpen)

  // main->renderer events + native menu command bus
  useIpcEvents()

  // Load settings on mount, and refresh on focus so footer/output-dir stay in
  // sync after edits made in the Settings window (M3 adds a push channel).
  useEffect(() => {
    void useSettingsStore.getState().load()
    const refresh = (): void => void useSettingsStore.getState().load()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        {/* min-w-0 lets this flex child shrink below its content's intrinsic
            width, so the filmstrip's wide preview/strip scroll instead of
            forcing the whole layout past the window edge. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {hasFiles ? <QueueView mode={viewMode} /> : <DropZone />}
        </div>
        {inspectorOpen && <Inspector />}
      </div>
      <Footer />
      <ReconversionDialog />
    </div>
  )
}

function QueueView({ mode }: { mode: QueueViewMode }): React.JSX.Element {
  switch (mode) {
    case 'grid':
      return <FileGrid />
    case 'filmstrip':
      return <FileFilmstrip />
    default:
      return <FileQueue />
  }
}
