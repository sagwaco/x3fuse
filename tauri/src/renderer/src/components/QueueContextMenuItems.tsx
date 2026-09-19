import { ipc } from '../lib/ipc'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { ContextMenuItem, ContextMenuSeparator } from './ui/contextMenu'

/** Browsing actions do not depend on past conversions. */
export function QueueContextMenuItems(): React.JSX.Element {
  const { files, selectedIds, isProcessing, isPreparing, isCancelling, draft } = useQueueStore()
  const selected = files.filter((f) => selectedIds.has(f.id))
  const store = useQueueStore.getState
  const busy = isProcessing || isPreparing || draft !== null
  return (
    <>
      <ContextMenuItem
        disabled={
          busy || !files.length || (selected.length ? selected : files).some((f) => f.pending)
        }
        onSelect={() =>
          selected.length ? store().openExport(selectedIds) : store().convertAllMenu()
        }
      >
        {selected.length ? t('context.convert_selected') : t('context.convert_all')}
      </ContextMenuItem>
      {isProcessing && !isCancelling && (
        <ContextMenuItem onSelect={() => store().stop()}>
          {t('context.stop_conversion')}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={busy || !files.length}
        onSelect={() => (selected.length ? store().removeSelected() : store().clearQueue())}
      >
        {selected.length ? t('context.remove_selected') : t('context.remove_all')}
      </ContextMenuItem>
      {selected.length > 0 && (
        <>
          <ContextMenuItem
            onSelect={() =>
              selected.forEach((f) => void ipc.invoke('shell:reveal', { path: f.path }))
            }
          >
            {t('context.show_in_finder')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => store().deselectAll()}>
            {t('context.deselect_all')}
          </ContextMenuItem>
        </>
      )}
    </>
  )
}
