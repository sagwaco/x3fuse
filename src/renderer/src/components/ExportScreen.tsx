import * as Dialog from '@radix-ui/react-dialog'
import { cameraModel } from '@shared/types'
import { ResizablePanel } from './ui/resizablePanel'
import { Loader2, Upload } from 'lucide-react'
import {
  exportSettings,
  hasMixedExportSettings,
  renderedOnly,
  useQueueStore
} from '../stores/queueStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { ConversionSettingsForm } from './ConversionSettingsForm'
import { QueueView } from './QueueView'
import { ViewControls } from './ViewControls'
import { ZoomControls } from './ZoomControls'
import { useSettingsStore } from '../stores/settingsStore'
import { PhotoInfo } from './PhotoInfo'

/**
 * Review screen reached by the toolbar's "Export" button. Shows a preview of
 * the files about to be exported alongside the (editable) output + export
 * settings, then commits a fixed batch and returns to browsing.
 */
export function ExportScreen(): React.JSX.Element {
  const viewMode = useSettingsStore((s) => s.settings.queueViewMode)
  const draft = useQueueStore((s) => s.draft)
  const busy = useQueueStore((s) => s.isProcessing || s.isPreparing)
  const error = useQueueStore((s) => s.error)
  const updateDraft = useQueueStore((s) => s.updateDraft)
  const cancelExport = useQueueStore((s) => s.cancelExport)
  const commitExport = useQueueStore((s) => s.commitExport)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const activeId = useQueueStore((s) => s.activeId)
  const resolveSettings = useQueueStore((s) => s.resolveDraftSettings)
  if (!draft) return <></>
  const targets = draft.files
  const count = targets.length
  const selected = targets.filter((file) => selectedIds.has(file.id))
  const x3iCount = selected.filter((file) => !!file.frames || /\.x3i$/i.test(file.path)).length
  const hasDng = selected.some(renderedOnly)
  const active = selected.find((file) => file.id === activeId) ?? selected[0]
  const mixed = hasMixedExportSettings(draft, selectedIds)

  return (
    <div className="flex h-full min-h-0 flex-col bg-tone-950 text-tone-100">
      <div
        data-tauri-drag-region
        className="window-toolbar flex h-12 shrink-0 items-center justify-between border-b border-ink/10 px-3"
      >
        <div className="flex items-center gap-3">
          <ViewControls disabled={count === 0} exportView />
          {viewMode === 'filmstrip' && (
            <>
              <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-ink/15" />
              <ZoomControls />
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={cancelExport} disabled={busy}>
            {t('button.cancel')}
          </Button>
          <Button
            variant="ghost"
            className="export-action"
            size="sm"
            disabled={busy || count === 0 || mixed}
            onClick={() => void commitExport()}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t('button.convert')}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="px-4 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {/* Body: preview gallery · settings sidebar */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {count > 0 ? (
            <QueueView
              mode={viewMode}
              draft={{
                ...draft,
                files: draft.files.map((file) =>
                  exportSettings(draft, file.id).rendering === 'original'
                    ? { ...file, edit: undefined, displayPreviewUrl: undefined }
                    : file
                )
              }}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-tone-600">
              {t('export.empty')}
            </div>
          )}
        </div>

        <ResizablePanel kind="export">
          <div className="flex h-8 shrink-0 items-center border-b border-ink/10 px-3 font-mono text-xs font-medium uppercase tracking-[0.12em] text-tone-400">
            <div className="ml-0.5 flex min-w-0 items-center gap-1.5">
              {selected.length > 1 ? (
                t('batch.image_count', { count: selected.length })
              ) : active ? (
                <PhotoInfo file={active} />
              ) : (
                t('inspector.no_selection')
              )}
            </div>
          </div>
          <div
            className="export-settings min-h-0 flex-1 overflow-y-auto"
            {...(busy || mixed || !active ? { inert: '' } : {})}
          >
            <fieldset disabled={busy || mixed || !active} className="contents">
              <ConversionSettingsForm
                key={active?.id}
                settings={active ? exportSettings(draft, active.id) : draft.settings}
                update={updateDraft}
                renderedOnly={draft.returnScreen === 'editor' || hasDng}
                hasDng={hasDng}
                hasX3i={x3iCount > 0}
                partialX3i={x3iCount > 0 && x3iCount < selected.length}
                cameraModels={selected.map(cameraModel)}
                disabled={busy || mixed || !active}
              />
            </fieldset>
          </div>
          <Dialog.Root
            open={mixed}
            modal={false}
            onOpenChange={(open) => {
              if (!open) resolveSettings(false)
            }}
          >
            {mixed && <div className="absolute inset-0 z-30 bg-tone-950/80 backdrop-blur-sm" />}
            <Dialog.Content
              className="absolute inset-x-3 top-1/2 z-40 flex -translate-y-1/2 flex-col gap-4 rounded-xl border border-ink/15 bg-tone-900 p-4 shadow-xl focus:outline-none"
              onInteractOutside={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <Dialog.Title className="text-sm font-semibold text-tone-100">
                {t('export.mixed_title')}
              </Dialog.Title>
              <Dialog.Description className="text-sm text-tone-300">
                {t('export.mixed_description', { name: active?.fileName })}
              </Dialog.Description>
              <div className="flex flex-wrap justify-end gap-2">
                <Button onClick={() => resolveSettings(false)}>{t('button.cancel')}</Button>
                <Button variant="prominent" disabled={busy} onClick={() => resolveSettings(true)}>
                  {t('button.overwrite')}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Root>
        </ResizablePanel>
      </div>
    </div>
  )
}
