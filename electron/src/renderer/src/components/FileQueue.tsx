import { memo, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { SortField, X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useFileDrop } from '../hooks/useFileDrop'
import { useQueueSelection, type QueueSelection } from '../hooks/useQueueSelection'
import { useScrollToActive } from '../hooks/useScrollToActive'
import { sortFiles } from '../lib/sortFiles'
import { formatBytes, formatDateWithOrdinal } from '../lib/format'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'
import { StatusIcon } from './StatusIcon'
import { QueueContextMenu } from './QueueContextMenu'

const ROW_HEIGHT = 30
const GRID = 'grid grid-cols-[28px_minmax(0,1fr)_220px_110px] items-center gap-2 px-3'

/** Virtualized queue table (port of FileQueueView): selection, sort, drag-drop. */
export function FileQueue(): React.JSX.Element {
  const files = useQueueStore((s) => s.files)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const activeId = useQueueStore((s) => s.activeId)
  const sortField = useSettingsStore((s) => s.settings.sortField)
  const sortAscending = useSettingsStore((s) => s.settings.sortAscending)
  const updateSettings = useSettingsStore((s) => s.update)

  const sorted = useMemo(
    () => sortFiles(files, sortField, sortAscending),
    [files, sortField, sortAscending]
  )

  const parentRef = useRef<HTMLDivElement>(null)
  const { isDragOver, dropHandlers } = useFileDrop()
  const sel = useQueueSelection(sorted, { mode: 'vertical' })

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14
  })

  // Focus the surface on mount so arrow-key navigation works without a click.
  useEffect(() => parentRef.current?.focus(), [])

  useScrollToActive(virtualizer, sorted, activeId)

  function toggleSort(field: SortField): void {
    if (sortField === field) void updateSettings({ sortAscending: !sortAscending })
    else void updateSettings({ sortField: field, sortAscending: true })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <QueueHeader sortField={sortField} sortAscending={sortAscending} onSort={toggleSort} />

      <QueueContextMenu>
        <div
          ref={parentRef}
          tabIndex={0}
          onKeyDown={sel.handleKeyDown}
          onContextMenu={sel.handleContainerContextMenu}
          {...dropHandlers}
          className={cn(
            'relative min-h-0 flex-1 overflow-auto outline-none',
            '[scrollbar-gutter:stable]'
          )}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const file = sorted[vi.index]
              return (
                <Row
                  key={file.id}
                  file={file}
                  index={vi.index}
                  selected={selectedIds.has(file.id)}
                  active={activeId === file.id}
                  height={vi.size}
                  translateY={vi.start}
                  sel={sel}
                />
              )
            })}
          </div>

          {isDragOver && (
            <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-blue-500/40 bg-blue-500/5" />
          )}
        </div>
      </QueueContextMenu>
    </div>
  )
}

function QueueHeader({
  sortField,
  sortAscending,
  onSort
}: {
  sortField: SortField
  sortAscending: boolean
  onSort: (field: SortField) => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        GRID,
        'h-8 shrink-0 border-b border-white/10 text-xs font-medium text-neutral-400',
        '[scrollbar-gutter:stable]'
      )}
    >
      <span />
      <SortableHeader
        label={t('queue.column.name')}
        active={sortField === 'File Name'}
        ascending={sortAscending}
        onClick={() => onSort('File Name')}
      />
      <SortableHeader
        label={t('queue.column.date')}
        active={sortField === 'Date'}
        ascending={sortAscending}
        onClick={() => onSort('Date')}
      />
      <SortableHeader
        label={t('queue.column.size')}
        active={sortField === 'Size'}
        ascending={sortAscending}
        onClick={() => onSort('Size')}
      />
    </div>
  )
}

function SortableHeader({
  label,
  active,
  ascending,
  onClick
}: {
  label: string
  active: boolean
  ascending: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 self-center text-left hover:text-neutral-200"
    >
      <span>{label}</span>
      {active &&
        (ascending ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
    </button>
  )
}

// Memoized so high-frequency progress events only re-render the row whose file
// object actually changed; geometry comes in as primitives so the comparison
// isn't defeated by a fresh style object per render.
const Row = memo(function Row({
  file,
  index,
  selected,
  active,
  height,
  translateY,
  sel
}: {
  file: X3FFileDTO
  index: number
  selected: boolean
  active: boolean
  height: number
  translateY: number
  sel: QueueSelection
}): React.JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height,
        transform: `translateY(${translateY}px)`
      }}
      onClick={(e) => sel.handleItemClick(e, file.id, index)}
      onDoubleClick={() => sel.handleItemDoubleClick(file.id)}
      onContextMenu={() => sel.handleItemContextMenu(file.id)}
      className={cn(
        GRID,
        'cursor-default text-sm',
        selected ? 'bg-blue-600/30 text-neutral-50' : 'text-neutral-200 hover:bg-white/5',
        active && 'ring-1 ring-inset ring-blue-400/40'
      )}
    >
      <span className="flex items-center justify-center">
        <StatusIcon file={file} />
      </span>
      <span className="truncate" title={file.fileName}>
        {file.fileName}
      </span>
      <span className="truncate text-neutral-400">
        {file.pending ? (
          <Skeleton className="w-28" />
        ) : file.capturedDate ? (
          formatDateWithOrdinal(file.capturedDate)
        ) : (
          t('placeholder.dash')
        )}
      </span>
      <span className="text-neutral-400">
        {file.pending ? (
          <Skeleton className="w-12" />
        ) : file.fileSize != null ? (
          formatBytes(file.fileSize)
        ) : (
          t('placeholder.dash')
        )}
      </span>
    </div>
  )
})

/** Shimmer bar standing in for a metadata cell that hasn't loaded yet. */
function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <span className={cn('inline-block h-3 animate-pulse rounded bg-white/10', className)} />
}
