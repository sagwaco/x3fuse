import { Loader2, PanelRight, Square } from 'lucide-react'
import { useQueueStore } from '../stores/queueStore'
import { useNavStore } from '../stores/navStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { ViewControls } from './ViewControls'
import { ZoomControls } from './ZoomControls'
import { useSettingsStore } from '../stores/settingsStore'

/** Top toolbar: Stop (while cancellable) + Convert (port of ContentView toolbar). */
export function Toolbar(): React.JSX.Element {
  const fileCount = useQueueStore((s) => s.files.length)
  const isProcessing = useQueueStore((s) => s.isProcessing)
  const isCancelling = useQueueStore((s) => s.isCancelling)
  const selectionCount = useQueueStore((s) => s.selectedIds.size)
  const stop = useQueueStore((s) => s.stop)
  const goToExport = useNavStore((s) => s.goToExport)
  const inspectorOpen = useSettingsStore((s) => s.settings.inspectorOpen)
  const updateSettings = useSettingsStore((s) => s.update)

  const canCancel = isProcessing && !isCancelling
  const canConvert = fileCount > 0 && !isProcessing
  const convertHelp =
    fileCount > 0 && selectionCount > 0 ? t('toolbar.convert_selected') : t('toolbar.convert_all')

  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-3">
      <div className="flex items-center gap-3">
        <span className="text-xs tabular-nums text-neutral-500">
          {fileCount > 0 ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'}` : ''}
        </span>
        {fileCount > 0 && (
          <>
            <ViewControls />
            <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-white/15" />
            <ZoomControls />
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {canCancel && (
          <Button
            variant="destructive"
            size="sm"
            onClick={stop}
            title={t('toolbar.stop_conversion')}
          >
            <Square className="h-3 w-3 fill-current" />
            {t('button.stop')}
          </Button>
        )}

        <Button
          variant="prominent"
          size="sm"
          disabled={!canConvert}
          onClick={goToExport}
          title={convertHelp}
        >
          {isProcessing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('button.convert')}
        </Button>
        {fileCount > 0 && (
          <Button
            variant="ghost"
            size="icon"
            title={t('inspector.toggle')}
            aria-label={t('inspector.toggle')}
            aria-pressed={inspectorOpen}
            className={inspectorOpen ? 'bg-white/15 text-neutral-100' : ''}
            onClick={() => void updateSettings({ inspectorOpen: !inspectorOpen })}
          >
            <PanelRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  )
}
