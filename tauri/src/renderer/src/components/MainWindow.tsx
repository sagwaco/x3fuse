import { useEffect, useMemo, useRef } from 'react'
import { displayPreviewUrl } from '@shared/preview'
import { prefetchFitPreviews } from '../lib/fitPreviews'
import { sortFiles } from '../lib/sortFiles'
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
import { EditorScreen } from './EditorScreen'
import { useEditorStore } from '../stores/editorStore'

/** The conversion-queue window (port of ContentView). */
export function MainWindow(): React.JSX.Element {
  const closing = useEditorStore((state) => state.closing)
  const hasFiles = useQueueStore((s) => s.files.length > 0)
  const viewMode = useSettingsStore((s) => s.settings.queueViewMode)
  const inspectorOpen = useSettingsStore((s) => s.settings.inspectorOpen)
  const onExportScreen = useNavStore((s) => s.screen === 'export')
  const onEditorScreen = useNavStore((s) => s.screen === 'editor')

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
    <div
      ref={(node) => {
        if (node) node.inert = closing
      }}
      aria-busy={closing || undefined}
      className="flex h-full flex-col bg-neutral-950 text-neutral-100"
    >
      {onExportScreen && hasFiles ? (
        <ExportScreen />
      ) : onEditorScreen && hasFiles ? (
        <EditorScreen />
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
      <PreviewPreparation />
      <ReconversionDialog />
    </div>
  )
}

/** Prepare Fit images while browsing any view; keep background work out of exports. */
export function PreviewPreparation(): null {
  const files = useQueueStore((state) => state.files)
  const activeId = useQueueStore((state) => state.activeId)
  const isProcessing = useQueueStore((state) => state.isProcessing)
  const isPreparing = useQueueStore((state) => state.isPreparing)
  const screen = useNavStore((state) => state.screen)
  const editorBusy = useEditorStore(
    (state) =>
      state.closing ||
      (screen === 'editor' &&
        (state.loading ||
          state.rendering ||
          !!(state.session && state.documents[state.session.path]?.gesture)))
  )
  const stop = useRef<(() => void) | undefined>()
  const sortField = useSettingsStore((state) => state.settings.sortField)
  const sortAscending = useSettingsStore((state) => state.settings.sortAscending)
  const sorted = useMemo(
    () => sortFiles(files, sortField, sortAscending),
    [files, sortField, sortAscending]
  )
  // Warm nearby images first, then the remaining queue, one background job at a time.
  const previewSources = useMemo(
    () =>
      sorted
        .filter((file) => !file.pending)
        .map((file) => ({ id: file.id, source: displayPreviewUrl(file, 'full') }))
        .filter((file) => file.source),
    [sorted]
  )
  useEffect(() => {
    if (isProcessing || isPreparing || editorBusy) {
      stop.current?.()
      stop.current = undefined
      return
    }
    const timer = setTimeout(() => {
      const index = previewSources.findIndex((file) => file.id === activeId)
      const nearby =
        index < 0
          ? []
          : [
              previewSources[index],
              previewSources[index + 1],
              previewSources[index - 1],
              previewSources[index + 2]
            ]
      const sources = new Set(nearby.filter(Boolean).map((file) => file.source))
      for (const file of previewSources) sources.add(file.source)
      stop.current = prefetchFitPreviews([...sources])
    }, 150)
    return () => {
      clearTimeout(timer)
    }
  }, [activeId, previewSources, isProcessing, isPreparing, screen, editorBusy])
  // Reordering/adding photos keeps useful work running. Only pause/unmount cancels it.
  useEffect(() => () => stop.current?.(), [])

  return null
}
