import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { ListColumnWidths, SortField, X3FFileDTO } from '@shared/types'
import { exportSettings, useQueueStore, type ExportDraft } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useFileDrop } from '../hooks/useFileDrop'
import { useQueueSelection, type QueueSelection } from '../hooks/useQueueSelection'
import { useMarquee } from '../hooks/useMarquee'
import { MarqueeBox } from './ui/marqueeBox'
import { useScrollToActive } from '../hooks/useScrollToActive'
import { useElementWidth } from '../hooks/useElementWidth'
import { useShownFiles } from '../hooks/useCulling'
import { formatBytes, formatDateWithOrdinal } from '../lib/format'
import { t, useLanguage } from '../lib/strings'
import { cn } from '../lib/cn'
import { QueueContextMenu } from './QueueContextMenu'
import { Thumbnail } from './Thumbnail'
import { CullBadge } from './CullBadge'
import { StackBadge } from './StackBadge'
import { ResizeHandle } from './ui/resizeHandle'

const ROW_HEIGHT = 30
const HEADER_HEIGHT = 32
const GRID = 'file-queue-row grid grid-cols-[var(--queue-columns)] items-center gap-2 px-3'
// At this width or more, rows are inset with rounded corners, as in macOS lists.
const WIDE = 720
const INSET = 8
const COLUMNS = [
  { key: 'name', field: 'File Name', min: 180, max: 2000 },
  { key: 'date', field: 'Date', min: 80, max: 1000 },
  { key: 'size', field: 'Size', min: 64, max: 400 }
] as const

/** Virtualized queue table: shared column geometry, selection, sort, drag-drop. */
export function FileQueue({ draft }: { draft?: ExportDraft }): React.JSX.Element {
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const activeId = useQueueStore((s) => s.activeId)
  const sortField = useSettingsStore((s) => s.settings.sortField)
  const sortAscending = useSettingsStore((s) => s.settings.sortAscending)
  const savedWidths = useSettingsStore((s) => s.settings.listColumnWidths)
  const updateSettings = useSettingsStore((s) => s.update)
  const [resizing, setResizing] = useState<ListColumnWidths>()
  const sorted = useShownFiles(draft)
  const parentRef = useRef<HTMLDivElement>(null)
  const available = useElementWidth(parentRef)
  const requested = resizing ?? savedWidths
  const inset = available >= WIDE
  // Padding and gaps around the columns.
  const chrome = 40 + (inset ? 2 * INSET : 0) + (draft ? 140 : 0)
  const widths = {
    ...requested,
    name:
      requested.name ||
      Math.max(
        COLUMNS[0].min,
        Math.min(COLUMNS[0].max, Math.floor(available - requested.date - requested.size - chrome))
      )
  }
  const tableWidth = widths.name + widths.date + widths.size + chrome
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
  // Rows span the table, so only the vertical extent matters.
  const marquee = useMarquee(parentRef, ({ top, bottom }) =>
    sorted
      .slice(
        Math.max(0, Math.floor((top - HEADER_HEIGHT) / ROW_HEIGHT)),
        Math.max(0, Math.floor((bottom - HEADER_HEIGHT) / ROW_HEIGHT) + 1)
      )
      .map((file) => file.id)
  )
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
    for (const file of sorted) {
      let content: number
      if (column.key === 'name') {
        content = 36 + measure(file.fileName)
        if (file.edit && file.edit.revision > 0) content += 20
        if ((file.flag ?? 'unflagged') !== 'unflagged' || file.rating)
          content += 24 + measure('★'.repeat(file.rating ?? 0), 12)
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
          onClick={sel.handleContainerClick}
          onPointerDown={marquee.onPointerDown}
          {...(draft ? {} : dropHandlers)}
          className="relative min-h-0 flex-1 overflow-auto outline-none [scrollbar-gutter:stable]"
        >
          <div
            style={
              {
                width: Math.max(available, tableWidth),
                '--queue-columns': `${widths.name}px ${widths.date}px ${widths.size}px${draft ? ' 132px' : ''}`
              } as CSSProperties
            }
          >
            <div
              className={cn(
                GRID,
                'sticky top-0 z-10 h-8 border-b border-ink/10 bg-tone-950 text-xs font-medium text-tone-400',
                inset && 'px-5'
              )}
              onClick={(e) => e.stopPropagation()}
              data-no-marquee
            >
              {COLUMNS.map((column) => (
                <div key={column.key} className="relative flex h-full min-w-0 items-center">
                  <button
                    type="button"
                    onClick={() => toggleSort(column.field)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-1 pr-2 text-left hover:text-tone-200',
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
                    className="-right-1 inset-y-0 border-r border-ink/15"
                  />
                </div>
              ))}
              {draft && <span className="truncate pl-2">{t('export.format_column')}</span>}
            </div>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const file = sorted[vi.index]
                const selected = selectedIds.has(file.id)
                return (
                  <Row
                    key={file.id}
                    file={file}
                    exportFormat={draft ? exportSettings(draft, file.id).outputFormat : undefined}
                    index={vi.index}
                    selected={selected}
                    // Adjacent selected rows join into one block.
                    joinTop={selected && selectedIds.has(sorted[vi.index - 1]?.id)}
                    joinBottom={selected && selectedIds.has(sorted[vi.index + 1]?.id)}
                    inset={inset}
                    height={vi.size}
                    translateY={vi.start - HEADER_HEIGHT}
                    sel={sel}
                  />
                )
              })}
            </div>
          </div>
          <MarqueeBox box={marquee.box} />
          {!draft && isDragOver && (
            <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-accent/40 bg-accent/5" />
          )}
        </div>
      </QueueContextMenu>
    </div>
  )
}

// Geometry is inherited through CSS so dragging does not rerender every row.
const Row = memo(function Row({
  file,
  exportFormat,
  index,
  selected,
  joinTop,
  joinBottom,
  inset,
  height,
  translateY,
  sel
}: {
  file: X3FFileDTO
  exportFormat?: string
  index: number
  selected: boolean
  joinTop: boolean
  joinBottom: boolean
  inset: boolean
  height: number
  translateY: number
  sel: QueueSelection
}): React.JSX.Element {
  // Memo skips the parent's render, so this renders again for a new language.
  useLanguage()
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: inset ? INSET : 0,
        width: inset ? `calc(100% - ${2 * INSET}px)` : '100%',
        height,
        transform: `translateY(${translateY}px)`
      }}
      onClick={(e) => sel.handleItemClick(e, file.id, index)}
      onDoubleClick={() => sel.handleItemDoubleClick(file.id)}
      onContextMenu={() => sel.handleItemContextMenu(file.id)}
      data-selected={selected || undefined}
      className={cn(
        GRID,
        'group cursor-default text-[13px]',
        inset && 'rounded-md',
        joinTop && 'rounded-t-none',
        joinBottom && 'rounded-b-none',
        selected
          ? 'bg-yellow-400/20 text-tone-50'
          : cn('text-tone-200 hover:bg-ink/5', index % 2 === 1 && 'bg-ink/[0.03]')
      )}
    >
      <div className="flex min-w-0 items-center gap-2" title={file.fileName}>
        <div aria-hidden="true" className="shrink-0">
          <Thumbnail file={file} maxEdge={84} className="h-6 w-7 [&_canvas]:rounded-[3px]" />
        </div>
        <span className="truncate">{file.fileName}</span>
        <CullBadge file={file} />
        <StackBadge file={file} />
      </div>
      <span className="truncate pl-2 text-tone-400 group-data-[selected]:text-tone-100">
        {file.pending ? (
          <Skeleton className="w-28" />
        ) : file.capturedDate ? (
          formatDateWithOrdinal(file.capturedDate)
        ) : (
          t('placeholder.dash')
        )}
      </span>
      <span className="truncate pl-2 text-tone-400 group-data-[selected]:text-tone-100">
        {file.pending ? (
          <Skeleton className="w-12" />
        ) : file.fileSize != null ? (
          formatBytes(file.fileSize)
        ) : (
          t('placeholder.dash')
        )}
      </span>
      {exportFormat && (
        <span className="truncate pl-2 text-tone-400 group-data-[selected]:text-tone-100">
          {exportFormat === 'embeddedJpg' ? 'Embedded JPG' : exportFormat.toUpperCase()}
        </span>
      )}
    </div>
  )
})

function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <span className={cn('inline-block h-3 animate-pulse rounded bg-ink/10', className)} />
}
