import { useEffect, useMemo, useRef } from 'react'
import { displayPreviewUrl } from '@shared/preview'
import { prefetchFitPreviews } from '../lib/fitPreviews'
import { ipc } from '../lib/ipc'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useNavStore } from '../stores/navStore'
import { useIpcEvents } from '../hooks/useIpcEvents'
import { useCullingKeys, useShownFiles } from '../hooks/useCulling'
import { FilterBar } from './FilterBar'
import { Toolbar } from './Toolbar'
import { DropZone } from './DropZone'
import { Inspector } from './Inspector'
import { QueueView } from './QueueView'
import { ExportScreen } from './ExportScreen'
import { ReconversionDialog } from './ReconversionDialog'
import { EditorScreen } from './EditorScreen'
import { useEditorStore, isTextEditing } from '../stores/editorStore'

/** The conversion-queue window (port of ContentView). */
export function MainWindow(): React.JSX.Element {
  const closing = useEditorStore((state) => state.closing)
  const hasFiles = useQueueStore((s) => s.files.length > 0)
  const viewMode = useSettingsStore((s) => s.settings.queueViewMode)
  const inspectorOpen = useSettingsStore((s) => s.settings.inspectorOpen)
  const onExportScreen = useNavStore((s) => s.screen === 'export')
  const onEditorScreen = useNavStore((s) => s.screen === 'editor')
  const filterOpen = useQueueStore((s) => s.filterOpen)

  // main->renderer events + native menu command bus
  useIpcEvents()
  useCullingKeys()

  // Refresh app preferences on focus. Export drafts keep their own snapshot.
  useEffect(() => {
    void useSettingsStore.getState().load()
    const refresh = (): void => void useSettingsStore.getState().load()
    window.addEventListener('focus', refresh)
    const off = ipc.on('settings:changed', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      off()
    }
  }, [])

  // Copy and paste adjustments between selected photos. The editor has its own shortcuts.
  useEffect(() => {
    if (onExportScreen || onEditorScreen) return
    const keydown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if (
        !(event.metaKey || event.ctrlKey) ||
        (key !== 'c' && key !== 'v') ||
        isTextEditing(event.target) ||
        event.defaultPrevented
      )
        return
      event.preventDefault()
      if (key === 'c') useEditorStore.getState().copy()
      else void useEditorStore.getState().paste()
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [onExportScreen, onEditorScreen])

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
      className="flex h-full flex-col bg-tone-950 text-tone-100"
    >
      {onExportScreen && hasFiles ? (
        <ExportScreen />
      ) : onEditorScreen && hasFiles ? (
        <EditorScreen />
      ) : (
        <>
          <Toolbar />
          {hasFiles && filterOpen && <FilterBar />}
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

/** How long a selection rests before its RAW is prepared for Edit. */
const WARM_DELAY = 300

/** Prepare Fit images while browsing any view; keep background work out of exports. */
export function PreviewPreparation(): null {
  const activeId = useQueueStore((state) => state.activeId)
  const activePath = useQueueStore(
    (state) => state.files.find((file) => file.id === state.activeId && !file.pending)?.path
  )
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
  // Warm the photos that the filter shows, nearest first.
  const sorted = useShownFiles()
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
  // Prepare the selected RAW while it rests, so that Edit opens it without a decode.
  useEffect(() => {
    if (!activePath || screen !== 'queue' || isProcessing || isPreparing || editorBusy) return
    const timer = setTimeout(() => {
      ipc.invoke('editor:warm', { path: activePath }).catch(() => {})
    }, WARM_DELAY)
    return () => clearTimeout(timer)
  }, [activePath, screen, isProcessing, isPreparing, editorBusy])
  // Reordering/adding photos keeps useful work running. Only pause/unmount cancels it.
  useEffect(() => () => stop.current?.(), [])

  return null
}
