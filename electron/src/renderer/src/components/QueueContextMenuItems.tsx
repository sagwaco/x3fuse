import { ipc } from '../lib/ipc'
import { useQueueStore } from '../stores/queueStore'
import { isQueued, isReconvertable } from '../lib/fileStatus'
import { t } from '../lib/strings'
import { ContextMenuItem, ContextMenuSeparator } from './ui/contextMenu'

const reveal = (path: string): void => void ipc.invoke('shell:reveal', { path })

/**
 * Context-menu contents for the queue, porting FileContextMenu (when files are
 * selected) and EmptySpaceContextMenu (when none are). Rendered inside the
 * Radix ContextMenu.Content in FileQueue; reads live store state so labels and
 * enabled/disabled track the selection.
 */
export function QueueContextMenuItems(): React.JSX.Element {
  const files = useQueueStore((s) => s.files)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const isProcessing = useQueueStore((s) => s.isProcessing)
  const isCancelling = useQueueStore((s) => s.isCancelling)
  const store = useQueueStore.getState

  if (selectedIds.size === 0) {
    return <EmptySpaceItems />
  }

  const selected = files.filter((f) => selectedIds.has(f.id))
  const queued = selected.filter(isQueued)
  const reconvertable = selected.filter(isReconvertable)
  const failed = selected.filter((f) => f.status === 'failed')
  const completed = selected.filter((f) => f.status === 'completed' || f.status === 'warning')
  const withOutput = completed.filter((f) => f.outputPath)
  const canCancel = isProcessing && !isCancelling

  return (
    <>
      {queued.length > 0 && (
        <ContextMenuItem
          disabled={isProcessing}
          onSelect={() => void store().convertSelected(new Set(queued.map((f) => f.id)))}
        >
          {queued.length === 1 ? t('context.convert') : t('context.convert_selected')}
        </ContextMenuItem>
      )}

      {reconvertable.length > 0 && (
        <ContextMenuItem
          disabled={isProcessing}
          onSelect={() => void store().reconvertSelected(new Set(reconvertable.map((f) => f.id)))}
        >
          {reconvertable.length === 1
            ? t('context.reconvert')
            : t('context.reconvert_selected')}
        </ContextMenuItem>
      )}

      {canCancel && (
        <>
          <ContextMenuItem onSelect={() => store().stop()}>
            {t('context.stop_conversion')}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}

      <ContextMenuItem
        disabled={isProcessing}
        onSelect={() => store().removeFiles(new Set(selected.map((f) => f.id)))}
      >
        {selected.length === 1 ? t('context.remove') : t('context.remove_selected')}
      </ContextMenuItem>

      <ContextMenuItem onSelect={() => selected.forEach((f) => reveal(f.path))}>
        {t('context.show_in_finder')}
      </ContextMenuItem>

      {withOutput.length > 0 && (
        <ContextMenuItem onSelect={() => withOutput.forEach((f) => reveal(f.outputPath as string))}>
          {withOutput.length === 1
            ? t('context.open_converted_in_finder')
            : t('context.open_converted_in_finder_multiple')}
        </ContextMenuItem>
      )}

      {(failed.length > 0 || completed.length > 0) && <ContextMenuSeparator />}

      {failed.length > 0 && (
        <ContextMenuItem disabled={isProcessing} onSelect={() => store().removeFailed()}>
          {failed.length === 1
            ? t('context.remove_failed_file')
            : t('context.remove_failed_files')}
        </ContextMenuItem>
      )}

      {completed.length > 0 && (
        <ContextMenuItem disabled={isProcessing} onSelect={() => store().removeCompleted()}>
          {completed.length === 1
            ? t('context.remove_completed_file')
            : t('context.remove_completed_files')}
        </ContextMenuItem>
      )}

      {(failed.length > 0 || completed.length > 0) && <ContextMenuSeparator />}

      <ContextMenuItem onSelect={() => store().deselectAll()}>
        {t('context.deselect_all')}
      </ContextMenuItem>
    </>
  )
}

function EmptySpaceItems(): React.JSX.Element {
  const files = useQueueStore((s) => s.files)
  const isProcessing = useQueueStore((s) => s.isProcessing)
  const store = useQueueStore.getState

  const hasQueued = files.some(isQueued)
  const hasFailed = files.some((f) => f.status === 'failed')
  const hasCompleted = files.some((f) => f.status === 'completed' || f.status === 'warning')

  return (
    <>
      {hasQueued && (
        <ContextMenuItem disabled={isProcessing} onSelect={() => void store().convertAllMenu()}>
          {t('context.convert_all')}
        </ContextMenuItem>
      )}

      {files.length > 0 && (
        <>
          <ContextMenuItem disabled={isProcessing} onSelect={() => store().clearQueue()}>
            {t('context.remove_all')}
          </ContextMenuItem>

          {(hasFailed || hasCompleted) && <ContextMenuSeparator />}

          {hasFailed && (
            <ContextMenuItem disabled={isProcessing} onSelect={() => store().removeFailed()}>
              {t('context.remove_failed_files')}
            </ContextMenuItem>
          )}

          {hasCompleted && (
            <ContextMenuItem disabled={isProcessing} onSelect={() => store().removeCompleted()}>
              {t('context.remove_completed_files')}
            </ContextMenuItem>
          )}
        </>
      )}
    </>
  )
}
