import { ChevronDown, PanelRight } from 'lucide-react'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { BatchProgress } from './BatchProgress'
import { Button } from './ui/button'
import { ViewControls } from './ViewControls'
import { ZoomControls } from './ZoomControls'
import { useSettingsStore } from '../stores/settingsStore'
import { NativeMenuButton } from './ui/nativeMenuButton'

/** Browsing controls, export status, and the split Export button. */
export function Toolbar(): React.JSX.Element {
  const fileCount = useQueueStore((s) => s.files.length)
  const isProcessing = useQueueStore((s) => s.isProcessing)
  const files = useQueueStore((s) => s.files)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const selected = files.filter((f) => selectedIds.has(f.id))
  const openExport = useQueueStore((s) => s.openExport)
  const isPreparing = useQueueStore((s) => s.isPreparing)
  const hasDraft = useQueueStore((s) => s.draft !== null)
  const convertPrevious = useQueueStore((s) => s.convertPrevious)
  const exportPreset = useQueueStore((s) => s.exportPreset)
  const loaded = useSettingsStore((s) => s.loaded)
  const hasPrevious = useSettingsStore((s) => s.settings.hasPreviousConversion)
  const inspectorOpen = useSettingsStore((s) => s.settings.inspectorOpen)
  const updateSettings = useSettingsStore((s) => s.update)

  const canConvert =
    loaded &&
    selected.length > 0 &&
    !selected.some((f) => f.pending) &&
    !isProcessing &&
    !isPreparing &&
    !hasDraft

  return (
    <div
      data-tauri-drag-region
      className="window-toolbar flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-3"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs tabular-nums text-neutral-500">
          {fileCount > 0 ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'}` : ''}
        </span>
        <ViewControls disabled={fileCount === 0} />
        <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-white/15" />
        <ZoomControls />
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <BatchProgress />
        <div
          role="group"
          aria-label={t('batch.convert_options')}
          className="flex shrink-0 items-center rounded-md bg-white/5"
        >
          <Button
            variant="ghost"
            size="md"
            className="px-2 rounded-r-none text-xs border-l border-t border-b border-white/10"
            disabled={!canConvert}
            onClick={() => openExport()}
            title={t('toolbar.convert_selected')}
          >
            {t('button.convert')}
          </Button>
          <NativeMenuButton
            variant="ghost"
            size="icon"
            className="w-6 rounded-l-none border-r border-t border-b border-white/10"
            disabled={!canConvert}
            aria-label={t('batch.convert_options')}
            items={[
              { value: 'embeddedJpg', label: t('batch.export_jpeg') },
              { value: 'dng', label: t('batch.export_dng') },
              { value: 'tiff', label: t('batch.export_tiff') },
              { value: 'previous', label: t('batch.convert_previous'), disabled: !hasPrevious }
            ]}
            onSelect={(value) => {
              if (value === 'previous') void convertPrevious()
              else if (value === 'embeddedJpg' || value === 'dng' || value === 'tiff')
                void exportPreset(value)
            }}
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </NativeMenuButton>
        </div>
        <Button
          variant="ghost"
          size="icon"
          disabled={fileCount === 0}
          title={t('inspector.toggle')}
          aria-label={t('inspector.toggle')}
          aria-pressed={inspectorOpen}
          className={inspectorOpen ? 'bg-white/15 text-neutral-100' : ''}
          onClick={() => void updateSettings({ inspectorOpen: !inspectorOpen })}
        >
          <PanelRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
