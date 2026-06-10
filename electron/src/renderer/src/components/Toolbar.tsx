import { Loader2, Square } from 'lucide-react'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { ViewControls } from './ViewControls'

/** Top toolbar: Stop (while cancellable) + Convert (port of ContentView toolbar). */
export function Toolbar(): React.JSX.Element {
  const fileCount = useQueueStore((s) => s.files.length)
  const isProcessing = useQueueStore((s) => s.isProcessing)
  const isCancelling = useQueueStore((s) => s.isCancelling)
  const selectionCount = useQueueStore((s) => s.selectedIds.size)
  const convertToolbar = useQueueStore((s) => s.convertToolbar)
  const stop = useQueueStore((s) => s.stop)

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
        {fileCount > 0 && <ViewControls />}
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
          onClick={() => void convertToolbar()}
          title={convertHelp}
        >
          {isProcessing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            t('button.convert')
          )}
        </Button>
      </div>
    </div>
  )
}
