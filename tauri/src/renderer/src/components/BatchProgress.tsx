import { memo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import * as Dialog from '@radix-ui/react-dialog'
import { Tooltip } from './ui/tooltip'
import {
  Check,
  CircleSlash,
  Clock,
  FolderOpen,
  LoaderCircle,
  Square,
  TriangleAlert
} from 'lucide-react'
import { useQueueStore, type BatchFileResult } from '../stores/queueStore'
import { ipc } from '../lib/ipc'
import { basename } from '../lib/path'
import { t } from '../lib/strings'
import { Button } from './ui/button'

const statusIcons = {
  queued: Clock,
  processing: LoaderCircle,
  completed: Check,
  failed: TriangleAlert,
  warning: TriangleAlert,
  cancelled: CircleSlash,
  unstarted: Clock
}

/** Only this toolbar surface observes conversion progress and results. */
export function BatchProgress(): React.JSX.Element | null {
  const batch = useQueueStore((s) => s.batch)
  const isProcessing = useQueueStore((s) => s.isProcessing)
  const isCancelling = useQueueStore((s) => s.isCancelling)
  const isPreparing = useQueueStore((s) => s.isPreparing)
  const stop = useQueueStore((s) => s.stop)
  const error = useQueueStore((s) => s.error)
  const [open, setOpen] = useState(false)
  if (!batch) return null
  const total = batch.results.length
  const processed = batch.results.filter((r) =>
    ['completed', 'failed', 'warning'].includes(r.status)
  ).length
  const progress = total ? batch.results.reduce((sum, r) => sum + r.progress, 0) / total : 0
  const summary = batch.summary
  const hasIssues = Boolean(error || summary?.failed || summary?.warnings)
  const title = isProcessing
    ? t(isCancelling ? 'batch.cancelling' : 'batch.progress', { processed, total })
    : error
      ? t('batch.failed')
      : summary?.cancelled
        ? t('batch.cancelled')
        : t('batch.summary', {
            completed: summary?.completed ?? 0,
            failed: summary?.failed ?? 0,
            warnings: summary?.warnings ?? 0
          })
  const ResultIcon = hasIssues ? TriangleAlert : summary?.cancelled ? CircleSlash : Check

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={isProcessing ? 'md' : 'icon'}
          className="shrink-0 text-xs tabular-nums"
          title={title}
          aria-label={`${t('batch.details')}: ${title}`}
        >
          {isProcessing ? (
            <>
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 -rotate-90"
                role="progressbar"
                aria-label={t('batch.progress_label')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
              >
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="text-white/15"
                />
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  pathLength="100"
                  strokeDasharray="100"
                  strokeDashoffset={100 - progress * 100}
                  strokeLinecap={progress ? 'round' : 'butt'}
                  className="text-blue-500"
                />
              </svg>
              <span aria-hidden="true">{t('batch.progress', { processed, total })}</span>
            </>
          ) : (
            <ResultIcon
              aria-hidden="true"
              className={`h-4 w-4 ${hasIssues ? 'text-red-400' : summary?.cancelled ? 'text-neutral-400' : 'text-green-400'}`}
            />
          )}
          <span role="status" className="sr-only">
            {title}
          </span>
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(560px,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-white/10 bg-neutral-900 p-5 text-neutral-100 shadow-xl">
          <Dialog.Title className="font-semibold">{t('batch.details')}</Dialog.Title>
          <Dialog.Description className="text-sm text-neutral-400">{title}</Dialog.Description>
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          <ConversionResults results={batch.results} />
          <div className="flex justify-end gap-2">
            {isProcessing && (
              <Button
                variant="destructive"
                size="sm"
                onClick={stop}
                disabled={isPreparing || isCancelling}
              >
                <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                {t(isCancelling ? 'batch.cancelling' : 'button.stop')}
              </Button>
            )}
            {!isProcessing && (
              <Button
                variant="bordered"
                size="sm"
                onClick={() => {
                  setOpen(false)
                  useQueueStore.getState().dismissBatch()
                }}
              >
                {t('batch.dismiss')}
              </Button>
            )}
            <Dialog.Close asChild>
              <Button variant="bordered" size="sm">
                {t('button.close')}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const ROW_HEIGHT = 41

function ConversionResults({ results }: { results: BatchFileResult[] }): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6
  })

  return (
    <div ref={parentRef} className="min-h-0 overflow-auto text-sm">
      <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <ConversionRow
            key={results[item.index].file.id}
            result={results[item.index]}
            index={item.index}
            total={results.length}
            translateY={item.start}
          />
        ))}
      </ul>
    </div>
  )
}

const ConversionRow = memo(function ConversionRow({
  result: r,
  index,
  total,
  translateY
}: {
  result: BatchFileResult
  index: number
  total: number
  translateY: number
}): React.JSX.Element {
  const fileName = r.outputPath ? basename(r.outputPath) : r.outputFileName
  const StatusIcon = statusIcons[r.status]
  const statusText = [t(`batch.status.${r.status}`), r.message].filter(Boolean).join(': ')
  const color =
    r.status === 'failed' || r.status === 'warning'
      ? 'text-red-400'
      : r.status === 'completed'
        ? 'text-green-400'
        : 'text-neutral-400'
  return (
    <li
      className="absolute left-0 top-0 flex w-full items-center gap-2 border-b border-white/10 py-1.5"
      style={{ height: ROW_HEIGHT, transform: `translateY(${translateY}px)` }}
      aria-posinset={index + 1}
      aria-setsize={total}
    >
      <span className="min-w-0 flex-1 truncate" title={r.outputPath ?? fileName}>
        {fileName}
      </span>
      {r.outputPath && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t('batch.reveal_output')}
          title={t('batch.reveal_output')}
          onClick={() => void ipc.invoke('shell:reveal', { path: r.outputPath! })}
        >
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
      <Tooltip text={statusText}>
        <span
          tabIndex={0}
          role="img"
          aria-label={statusText}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 ${color}`}
        >
          <StatusIcon
            className={`h-4 w-4 ${r.status === 'processing' ? 'motion-safe:animate-spin' : ''}`}
            aria-hidden="true"
          />
        </span>
      </Tooltip>
    </li>
  )
})
