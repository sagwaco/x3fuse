import { ChevronLeft, Loader2 } from 'lucide-react'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { ConversionSettingsForm } from './ConversionSettingsForm'
import { ExportPreviewGrid } from './ExportPreviewGrid'

/**
 * Pre-conversion review screen reached by the toolbar's "Convert" button. Shows
 * a preview of the files about to be converted alongside the (editable) output +
 * conversion settings, then commits a fixed batch and returns to browsing.
 */
export function ExportScreen(): React.JSX.Element {
  const draft = useQueueStore((s) => s.draft)
  const busy = useQueueStore((s) => s.isProcessing || s.isPreparing)
  const error = useQueueStore((s) => s.error)
  const updateDraft = useQueueStore((s) => s.updateDraft)
  const cancelExport = useQueueStore((s) => s.cancelExport)
  const commitExport = useQueueStore((s) => s.commitExport)
  if (!draft) return <></>
  const targets = draft.files
  const count = targets.length

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950 text-neutral-100">
      {/* Header: back · convert */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-3">
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={cancelExport}
            disabled={busy}
            title={t('export.back')}
          >
            <ChevronLeft className="h-4 w-4" />
            {t('export.back')}
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums text-neutral-500">
            {t('batch.image_count', { count })}
          </span>
          <Button
            variant="prominent"
            size="sm"
            disabled={busy || count === 0}
            onClick={() => void commitExport()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('button.convert')}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="px-4 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      {/* Body: preview gallery · settings sidebar */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center border-b border-white/10 px-4 text-xs font-medium text-neutral-400">
            {t('export.images_heading')}
          </div>
          {count > 0 ? (
            <ExportPreviewGrid files={targets} settings={draft.settings} />
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
              <fieldset disabled={busy} className="contents">
                <ConversionSettingsForm settings={draft.settings} update={updateDraft} />
              </fieldset>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
