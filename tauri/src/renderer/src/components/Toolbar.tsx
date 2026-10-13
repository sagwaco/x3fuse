import { ChevronDown, PanelRight, SwatchBook } from 'lucide-react'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { BatchProgress } from './BatchProgress'
import { Button } from './ui/button'
import { ViewControls } from './ViewControls'
import { ZoomControls } from './ZoomControls'
import { useSettingsStore } from '../stores/settingsStore'
import { NativeMenuButton } from './ui/nativeMenuButton'
import { useEditorStore } from '../stores/editorStore'
import { useToolbarSwap } from '../hooks/useToolbarSwap'

/** Browsing controls, export status, and the split Export button. */
export function Toolbar(): React.JSX.Element {
  const fileCount = useQueueStore((s) => s.files.length)
  const isProcessing = useQueueStore((s) => s.isProcessing)
  const files = useQueueStore((s) => s.files)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const selected = files.filter((f) => selectedIds.has(f.id))
  const isPreparing = useQueueStore((s) => s.isPreparing)
  const hasDraft = useQueueStore((s) => s.draft !== null)
  const loaded = useSettingsStore((s) => s.loaded)
  const inspectorOpen = useSettingsStore((s) => s.settings.inspectorOpen)
  const filmstrip = useSettingsStore((s) => s.settings.queueViewMode === 'filmstrip')
  const updateSettings = useSettingsStore((s) => s.update)
  // Nothing swaps here: the buttons only scale in when the screen opens, as in the editor.
  const { ref } = useToolbarSwap(false)

  const canConvert =
    loaded &&
    selected.length > 0 &&
    !selected.some((f) => f.pending) &&
    !isProcessing &&
    !isPreparing &&
    !hasDraft

  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="window-toolbar flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-3"
    >
      <div data-swap className="flex items-center gap-2">
        {fileCount > 0 && (
          <span className="font-mono text-xs uppercase tabular-nums tracking-[0.12em] text-neutral-500">
            {`${fileCount} ${fileCount === 1 ? 'file' : 'files'}`}
          </span>
        )}
        <ViewControls disabled={fileCount === 0} />
        {/* Only the filmstrip shows a photo to zoom. */}
        {filmstrip && (
          <>
            <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-white/15" />
            <ZoomControls />
          </>
        )}
      </div>

      <div data-swap className="flex min-w-0 items-center gap-2">
        <BatchProgress />
        <Button
          variant="ghost"
          size="md"
          disabled={!canConvert}
          onClick={() => {
            const file =
              selected.find((file) => file.id === useQueueStore.getState().activeId) ?? selected[0]
            if (file) void useEditorStore.getState().open(file)
          }}
        >
          <SwatchBook className="h-4 w-4" aria-hidden="true" />
          {t('editor.edit')}
        </Button>
        <ExportButton disabled={!canConvert} />
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
      </div>
    </div>
  )
}

/** Export opens the Export screen; its arrow exports at once with a preset. */
export function ExportButton({
  disabled,
  ids,
  returnScreen
}: {
  disabled: boolean
  /** The files to export. The default is the selection. */
  ids?: Set<string>
  returnScreen?: 'queue' | 'editor'
}): React.JSX.Element {
  const openExport = useQueueStore((s) => s.openExport)
  const convertPrevious = useQueueStore((s) => s.convertPrevious)
  const exportPreset = useQueueStore((s) => s.exportPreset)
  const hasPrevious = useSettingsStore((s) => s.settings.hasPreviousConversion)
  return (
    <div
      role="group"
      aria-label={t('batch.convert_options')}
      className="flex shrink-0 items-center rounded-md bg-white/5"
    >
      <Button
        variant="ghost"
        size="md"
        className="px-2 rounded-r-none text-xs border-l border-t border-b border-white/10"
        disabled={disabled}
        onClick={() => openExport(ids, returnScreen)}
        title={t('toolbar.convert_selected')}
      >
        {t('button.convert')}
      </Button>
      <NativeMenuButton
        variant="ghost"
        size="icon"
        className="w-6 rounded-l-none border-r border-t border-b border-white/10"
        disabled={disabled}
        aria-label={t('batch.convert_options')}
        items={[
          { value: 'jpeg', label: t('batch.export_jpeg') },
          // The editor offers only formats that include the edit.
          ...(returnScreen === 'editor'
            ? []
            : [
                { value: 'embeddedJpg', label: t('editor.exportEmbeddedJpeg') },
                { value: 'dng', label: t('batch.export_dng') }
              ]),
          { value: 'tiff', label: t('batch.export_tiff') },
          { value: 'previous', label: t('batch.convert_previous'), disabled: !hasPrevious }
        ]}
        onSelect={(value) => {
          if (value === 'previous') void convertPrevious(ids, returnScreen)
          else if (
            value === 'jpeg' ||
            value === 'embeddedJpg' ||
            value === 'dng' ||
            value === 'tiff'
          )
            void exportPreset(value, ids, returnScreen)
        }}
      >
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </NativeMenuButton>
    </div>
  )
}
