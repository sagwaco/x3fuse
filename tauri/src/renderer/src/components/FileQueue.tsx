import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { ListColumnWidths, SortField, X3FFileDTO } from '@shared/types'
import { useQueueStore, type ExportDraft } from '../stores/queueStore'
import { outputFileName } from '../lib/outputName'
import { useSettingsStore } from '../stores/settingsStore'
import { useFileDrop } from '../hooks/useFileDrop'
import { useQueueSelection, type QueueSelection } from '../hooks/useQueueSelection'
import { useScrollToActive } from '../hooks/useScrollToActive'
import { useElementWidth } from '../hooks/useElementWidth'
import { sortFiles } from '../lib/sortFiles'
import { formatBytes, formatDateWithOrdinal } from '../lib/format'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'
import { QueueContextMenu } from './QueueContextMenu'
import { Thumbnail } from './Thumbnail'
import { EditedBadge } from './EditedBadge'
import { ResizeHandle } from './ui/resizeHandle'

const ROW_HEIGHT = 30
const HEADER_HEIGHT = 32
const GRID = 'file-queue-row grid grid-cols-[var(--queue-columns)] items-center gap-2 px-3'
const COLUMNS = [
  { key: 'name', field: 'File Name', min: 180, max: 2000 },
  { key: 'date', field: 'Date', min: 80, max: 1000 },
  { key: 'size', field: 'Size', min: 64, max: 400 }
] as const

/** Virtualized queue table: shared column geometry, selection, sort, drag-drop. */
export function FileQueue({ draft }: { draft?: ExportDraft }): React.JSX.Element {
  const files = useQueueStore((s) => draft?.files ?? s.files)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const activeId = useQueueStore((s) => s.activeId)
  const sortField = useSettingsStore((s) => s.settings.sortField)
  const sortAscending = useSettingsStore((s) => s.settings.sortAscending)
  const savedWidths = useSettingsStore((s) => s.settings.listColumnWidths)
  const updateSettings = useSettingsStore((s) => s.update)
  const [resizing, setResizing] = useState<ListColumnWidths>()
  const sorted = useMemo(
    () => sortFiles(files, sortField, sortAscending),
    [files, sortField, sortAscending]
  )
  const parentRef = useRef<HTMLDivElement>(null)
  const available = useElementWidth(parentRef)
  const requested = resizing ?? savedWidths
  const widths = {
    ...requested,
    name:
      requested.name ||
      Math.max(
        COLUMNS[0].min,
        Math.min(COLUMNS[0].max, Math.floor(available - requested.date - requested.size - 40))
      )
  }
  const tableWidth = widths.name + widths.date + widths.size + 40
  const { isDragOver, dropHandlers } = useFileDrop()
  const sel = useQueueSelection(sorted, { mode: 'vertical' })
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    overscan: 14
  })
  useEffect(() => parentRef.current?.focus(), [])
  useScrollToActive(virtualizer, sorted, activeId)

  function toggleSort(field: SortField): void {
    if (sortField === field) void updateSettings({ sortAscending: !sortAscending })
    else void updateSettings({ sortField: field, sortAscending: true })
  }

  function saveWidth(key: keyof ListColumnWidths, width: number): void {
    void updateSettings({ listColumnWidths: { ...widths, [key]: width } })
    setResizing(undefined)
  }

  function autoFit(column: (typeof COLUMNS)[number]): void {
    const context = document.createElement('canvas').getContext('2d')
    if (!context || !parentRef.current) return
    const family = getComputedStyle(parentRef.current).fontFamily
    const measure = (text: string, size = 14, weight = 400): number => {
      context.font = `${weight} ${size}px ${family}`
      return context.measureText(text).width
    }
    let width =
      measure(t(`queue.column.${column.key}`), 12, 500) + 24 + (column.key === 'name' ? 0 : 8)
    for (const file of files) {
      let content: number
      if (column.key === 'name') {
        content = 36 + measure(file.fileName)
        if (file.edit && file.edit.revision > 0) content += 20
        if (draft) content += 8 + measure(`→ ${outputFileName(file, draft.settings)}`, 12)
      } else if (column.key === 'date') {
        content = measure(
          file.capturedDate ? formatDateWithOrdinal(file.capturedDate) : t('placeholder.dash')
        )
      } else {
        content = measure(
          file.fileSize != null ? formatBytes(file.fileSize) : t('placeholder.dash')
        )
      }
      width = Math.max(width, content + 8 + (column.key === 'name' ? 0 : 8))
    }
    saveWidth(column.key, Math.ceil(Math.max(column.min, Math.min(column.max, width))))
  }

  return (
    <div className="file-queue flex min-h-0 min-w-0 flex-1 flex-col">
      <QueueContextMenu disabled={!!draft}>
        <div
          ref={parentRef}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.target === event.currentTarget) sel.handleKeyDown(event)
          }}
          onContextMenu={sel.handleContainerContextMenu}
          {...(draft ? {} : dropHandlers)}
          className="relative min-h-0 flex-1 overflow-auto outline-none [scrollbar-gutter:stable]"
        >
          <div
            style={
              {
                width: Math.max(available, tableWidth),
                '--queue-columns': `${widths.name}px ${widths.date}px ${widths.size}px`
              } as CSSProperties
            }
          >
            <div
              className={cn(
                GRID,
                'sticky top-0 z-10 h-8 border-b border-white/10 bg-neutral-950 text-xs font-medium text-neutral-400'
              )}
            >
              {COLUMNS.map((column) => (
                <div key={column.key} className="relative flex h-full min-w-0 items-center">
                  <button
                    type="button"
                    onClick={() => toggleSort(column.field)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-1 pr-2 text-left hover:text-neutral-200',
                      column.key !== 'name' && 'pl-2'
                    )}
                  >
                    <span className="truncate">{t(`queue.column.${column.key}`)}</span>
                    {sortField === column.field &&
                      (sortAscending ? (
                        <ChevronUp className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      ))}
                  </button>
                  <ResizeHandle
                    label={t('layout.resize_column', { name: t(`queue.column.${column.key}`) })}
                    hint={t('layout.fit_column')}
                    value={widths[column.key]}
                    min={column.min}
                    max={column.max}
                    onChange={(width) => setResizing({ ...widths, [column.key]: width })}
                    onCommit={(width) => saveWidth(column.key, width)}
                    onCancel={() => setResizing(undefined)}
                    onReset={() => autoFit(column)}
                    className="-right-1 inset-y-0 border-r border-white/15"
                  />
                </div>
              ))}
            </div>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const file = sorted[vi.index]
                return (
                  <Row
                    key={file.id}
                    file={file}
                    outputName={draft ? outputFileName(file, draft.settings) : undefined}
                    index={vi.index}
                    selected={selectedIds.has(file.id)}
                    active={activeId === file.id}
                    height={vi.size}
                    translateY={vi.start - HEADER_HEIGHT}
                    sel={sel}
                  />
                )
              })}
            </div>
          </div>
          {!draft && isDragOver && (
            <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-blue-500/40 bg-blue-500/5" />
          )}
        </div>
      </QueueContextMenu>
    </div>
  )
}

// Geometry is inherited through CSS so dragging does not rerender every row.
const Row = memo(function Row({
  file,
  outputName,
  index,
  selected,
  active,
  height,
  translateY,
  sel
}: {
  file: X3FFileDTO
  outputName?: string
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
      <div
        className="flex min-w-0 items-center gap-2"
        title={outputName ? `${file.fileName} → ${outputName}` : file.fileName}
      >
        <div aria-hidden="true" className="shrink-0">
          <Thumbnail file={file} maxEdge={84} className="h-6 w-7 rounded-sm" />
        </div>
        <span className="truncate">
          {file.fileName}
          {outputName && <span className="ml-2 text-xs text-neutral-400">→ {outputName}</span>}
        </span>
        <EditedBadge edit={file.edit} />
      </div>
      <span className="truncate pl-2 text-neutral-400">
        {file.pending ? (
          <Skeleton className="w-28" />
        ) : file.capturedDate ? (
          formatDateWithOrdinal(file.capturedDate)
        ) : (
          t('placeholder.dash')
        )}
      </span>
      <span className="truncate pl-2 text-neutral-400">
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

function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <span className={cn('inline-block h-3 animate-pulse rounded bg-white/10', className)} />
}
