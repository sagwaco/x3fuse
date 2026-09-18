import { useMemo } from 'react'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { useQueueStore } from '../stores/queueStore'
import { useNavStore } from '../stores/navStore'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveConvertTargets } from '../lib/convertTargets'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { ConversionSettingsForm } from './ConversionSettingsForm'
import { ExportPreviewGrid } from './ExportPreviewGrid'

/**
 * Pre-conversion review screen reached by the toolbar's "Convert" button. Shows
 * a preview of the files about to be converted alongside the (editable) output +
 * conversion settings, then starts the same conversion the toolbar would have
 * run and returns to the queue to watch progress.
 */
export function ExportScreen(): React.JSX.Element {
  const files = useQueueStore((s) => s.files)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const isProcessing = useQueueStore((s) => s.isProcessing)
  const convertToolbar = useQueueStore((s) => s.convertToolbar)
  const goToQueue = useNavStore((s) => s.goToQueue)
  const onlyProcessNewItems = useSettingsStore((s) => s.settings.onlyProcessNewItems)

  // The same set the toolbar Convert would target; recomputed if the queue or
  // selection changes underneath us.
  const targets = useMemo(
    () => resolveConvertTargets(files, selectedIds, onlyProcessNewItems),
    [files, selectedIds, onlyProcessNewItems]
  )
  const count = targets.length

  function startExport(): void {
    // Kick off the conversion (which may surface the reconversion dialog) and
    // return to the queue so the user can watch per-file progress.
    void convertToolbar()
    goToQueue()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950 text-neutral-100">
      {/* Header: back · title · convert */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-3">
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={goToQueue} title={t('export.back')}>
            <ChevronLeft className="h-4 w-4" />
            {t('export.back')}
          </Button>
          <span className="text-sm font-medium text-neutral-200">{t('export.title')}</span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums text-neutral-500">
            {count > 0 ? `${count} ${count === 1 ? 'image' : 'images'}` : ''}
          </span>
          <Button
            variant="prominent"
            size="sm"
            disabled={isProcessing || count === 0}
            onClick={startExport}
          >
            {isProcessing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('button.convert')}
          </Button>
        </div>
      </div>

      {/* Body: preview gallery · settings sidebar */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center border-b border-white/10 px-4 text-xs font-medium text-neutral-400">
            {t('export.images_heading')}
          </div>
          {count > 0 ? (
            <ExportPreviewGrid files={targets} />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-neutral-600">
              {t('export.empty')}
            </div>
          )}
        </div>

        <aside className="flex w-[380px] shrink-0 flex-col border-l border-white/10 bg-neutral-900/30">
          <div className="flex h-8 shrink-0 items-center border-b border-white/10 px-4 text-xs font-medium text-neutral-400">
            {t('export.settings_heading')}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <div className="flex flex-col gap-6">
              <ConversionSettingsForm />
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
