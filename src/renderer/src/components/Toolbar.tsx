import {
  ChevronDown,
  ListFilter,
  PanelRight,
  SwatchBook,
  TriangleAlert,
  Upload
} from 'lucide-react'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { BatchProgress } from './BatchProgress'
import { Button } from './ui/button'
import { ViewControls } from './ViewControls'
import { ZoomControls } from './ZoomControls'
import { useSettingsStore } from '../stores/settingsStore'
import { cn } from '../lib/cn'
import { NativeMenuButton } from './ui/nativeMenuButton'
import { useEditorStore } from '../stores/editorStore'
import { useToolbarSwap } from '../hooks/useToolbarSwap'
import { isFiltering } from '../lib/culling'
import { withShortcut } from '../lib/shortcut'
import { EXPORT_SCREEN, useExportMenu } from '../hooks/useExportMenu'
import { useToolbarOverflow } from '../hooks/useToolbarOverflow'
import { OverflowMenu, type OverflowAction } from './ui/overflowMenu'

const OVERFLOW_ORDER = ['inspector', 'edit', 'export']

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
  // Narrow windows move the least important buttons into a menu, in this order.
  const hidden = useToolbarOverflow(ref, OVERFLOW_ORDER.length)
  const folded = new Set(OVERFLOW_ORDER.slice(0, hidden))
  const exportMenu = useExportMenu(undefined, undefined)

  const canConvert =
    loaded &&
    selected.length > 0 &&
    !selected.some((f) => f.pending) &&
    !isProcessing &&
    !isPreparing &&
    !hasDraft

  const edit = (): void => {
    const file =
      selected.find((file) => file.id === useQueueStore.getState().activeId) ?? selected[0]
    if (file) void useEditorStore.getState().open(file)
  }
  const toggleInspector = (): void => void updateSettings({ inspectorOpen: !inspectorOpen })
  // In toolbar order.
  const actions: OverflowAction[] = [
    {
      id: 'edit',
      label: t('editor.edit'),
      icon: SwatchBook,
      disabled: !canConvert,
      onSelect: edit
    },
    {
      id: 'export',
      label: t('button.convert'),
      icon: Upload,
      disabled: !canConvert,
      items: [{ value: EXPORT_SCREEN, label: t('toolbar.convert_selected') }, ...exportMenu.items],
      onSelect: (value) =>
        value === EXPORT_SCREEN ? exportMenu.openScreen() : exportMenu.select(value)
    },
    {
      id: 'inspector',
      label: t('inspector.toggle'),
      icon: PanelRight,
      pressed: inspectorOpen,
      onSelect: toggleInspector
    }
  ]
  // The overflow menu takes the place of the first folded button: the inspector toggle at
  // the end, then Edit, which folds before Export.
  const overflow = <OverflowMenu actions={actions.filter((action) => folded.has(action.id))} />

  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="window-toolbar flex h-12 shrink-0 items-center justify-between border-b border-ink/10 px-3"
    >
      <div data-swap className="flex items-center gap-2">
        <ViewControls disabled={fileCount === 0} />
        <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-ink/15" />
        <FilterButton disabled={fileCount === 0} shortcut />
        <CullError />
        {/* Only the filmstrip shows a photo to zoom. */}
        {filmstrip && (
          <>
            <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-ink/15" />
            <ZoomControls />
          </>
        )}
      </div>

      <div data-swap className="flex min-w-0 items-center gap-2">
        <BatchProgress />
        {folded.has('edit') && overflow}
        {!folded.has('edit') && (
          <Button variant="ghost" size="md" disabled={!canConvert} onClick={edit}>
            <SwatchBook className="h-4 w-4" aria-hidden="true" />
            {t('editor.edit')}
          </Button>
        )}
        {!folded.has('export') && <ExportButton disabled={!canConvert} />}
        {!folded.has('inspector') && (
          <Button
            variant="ghost"
            size="icon"
            title={t('inspector.toggle')}
            aria-label={t('inspector.toggle')}
            aria-pressed={inspectorOpen}
            className={inspectorOpen ? 'bg-ink/15 text-tone-100' : ''}
            onClick={toggleInspector}
          >
            <PanelRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
        {!folded.has('edit') && overflow}
      </div>
    </div>
  )
}

/** Shows that a flag or rating was not saved. The next saved change hides it. */
export function CullError(): React.JSX.Element | null {
  const error = useQueueStore((s) => s.cullError)
  if (!error) return null
  return (
    <span role="alert" title={error} className="flex items-center gap-1 text-xs text-danger">
      <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
      {t('cull.save_failed')}
    </span>
  )
}

/** Shows the filter bar. It stays highlighted while a filter hides photos. */
export function FilterButton({
  disabled = false,
  shortcut = false
}: {
  disabled?: boolean
  /** The editor uses the backslash key for Compare, so only the queue toolbar shows the key. */
  shortcut?: boolean
}): React.JSX.Element {
  const filtering = useQueueStore((s) => isFiltering(s.filter))
  const filterOpen = useQueueStore((s) => s.filterOpen)
  const label = t('filter.toggle')
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={disabled}
      title={shortcut ? withShortcut(label, '\\') : label}
      aria-label={label}
      aria-keyshortcuts={shortcut ? '\\' : undefined}
      aria-pressed={filterOpen}
      className={cn((filterOpen || filtering) && 'bg-ink/15 text-tone-100')}
      onClick={useQueueStore.getState().toggleFilterBar}
    >
      <ListFilter className="h-4 w-4" aria-hidden="true" />
    </Button>
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
  const { items, select } = useExportMenu(ids, returnScreen)
  return (
    <div
      role="group"
      aria-label={t('batch.convert_options')}
      className="flex shrink-0 items-center rounded-md bg-ink/5"
    >
      <Button
        variant="ghost"
        size="md"
        className="px-2 rounded-r-none text-xs border-l border-t border-b border-ink/10"
        disabled={disabled}
        onClick={() => openExport(ids, returnScreen)}
        title={t('toolbar.convert_selected')}
      >
        {t('button.convert')}
      </Button>
      <NativeMenuButton
        variant="ghost"
        size="icon"
        className="w-6 rounded-l-none border-r border-t border-b border-ink/10"
        disabled={disabled}
        aria-label={t('batch.convert_options')}
        items={items}
        onSelect={select}
      >
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </NativeMenuButton>
    </div>
  )
}
