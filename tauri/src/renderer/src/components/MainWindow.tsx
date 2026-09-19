import { useEffect } from 'react'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useNavStore } from '../stores/navStore'
import { useIpcEvents } from '../hooks/useIpcEvents'
import { Toolbar } from './Toolbar'
import { DropZone } from './DropZone'
import { Inspector } from './Inspector'
import { QueueView } from './QueueView'
import { ExportScreen } from './ExportScreen'
import { ReconversionDialog } from './ReconversionDialog'

/** The conversion-queue window (port of ContentView). */
export function MainWindow(): React.JSX.Element {
  const hasFiles = useQueueStore((s) => s.files.length > 0)
  const viewMode = useSettingsStore((s) => s.settings.queueViewMode)
  const inspectorOpen = useSettingsStore((s) => s.settings.inspectorOpen)
  const onExportScreen = useNavStore((s) => s.screen === 'export')

  // main->renderer events + native menu command bus
  useIpcEvents()

  // Refresh app preferences on focus. Export drafts keep their own snapshot.
  useEffect(() => {
    void useSettingsStore.getState().load()
    const refresh = (): void => void useSettingsStore.getState().load()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  // The Export screen only makes sense with files queued; if the queue empties
  // (e.g. the "Clear queue" menu command), fall back to the queue view.
  useEffect(() => {
    if (!hasFiles) useNavStore.getState().goToQueue()
  }, [hasFiles])

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      {onExportScreen && hasFiles ? (
        <ExportScreen />
      ) : (
        <>
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
        </>
      )}
      <ReconversionDialog />
    </div>
  )
}
