import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useFileDrop } from '../hooks/useFileDrop'
import { useQueueSelection } from '../hooks/useQueueSelection'
import { useElementWidth } from '../hooks/useElementWidth'
import { sortFiles } from '../lib/sortFiles'
import { cn } from '../lib/cn'
import { StatusIcon } from './StatusIcon'
import { Thumbnail } from './Thumbnail'
import { QueueContextMenu } from './QueueContextMenu'

const PADDING = 12
const GAP = 12
const MIN_CELL = 150
const THUMB_H = 120
const LABEL_H = 34
const ROW_HEIGHT = THUMB_H + LABEL_H + GAP

/** Thumbnail grid view: virtualized rows of embedded-preview cells. */
export function FileGrid(): React.JSX.Element {
  const files = useQueueStore((s) => s.files)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const activeId = useQueueStore((s) => s.activeId)
  const sortField = useSettingsStore((s) => s.settings.sortField)
  const sortAscending = useSettingsStore((s) => s.settings.sortAscending)

  const sorted = useMemo(
    () => sortFiles(files, sortField, sortAscending),
    [files, sortField, sortAscending]
  )

  const parentRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(parentRef)
  const { isDragOver, dropHandlers } = useFileDrop()

  const columns =
    width > 0 ? Math.max(1, Math.floor((width - 2 * PADDING + GAP) / (MIN_CELL + GAP))) : 1
  const rowCount = Math.ceil(sorted.length / columns)

  const sel = useQueueSelection(sorted, { mode: 'grid', columns })

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 4
  })

  // Focus the surface on mount so arrow-key navigation works without a click.
  useEffect(() => parentRef.current?.focus(), [])

  // Keep the keyboard cursor (active cell's row) scrolled into view.
  useEffect(() => {
    if (!activeId) return
    const idx = sorted.findIndex((f) => f.id === activeId)
    if (idx >= 0) virtualizer.scrollToIndex(Math.floor(idx / columns), { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, columns])

  return (
    <QueueContextMenu>
      <div
        ref={parentRef}
        tabIndex={0}
        onKeyDown={sel.handleKeyDown}
        onContextMenu={sel.handleContainerContextMenu}
        {...dropHandlers}
        className="relative min-h-0 flex-1 overflow-auto outline-none"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const start = vi.index * columns
            const rowFiles = sorted.slice(start, start + columns)
            return (
              <div
                key={vi.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`,
                  paddingLeft: PADDING,
                  paddingRight: PADDING,
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  columnGap: GAP
                }}
                className="grid"
              >
                {rowFiles.map((file, c) => (
                  <GridCell
                    key={file.id}
                    file={file}
                    selected={selectedIds.has(file.id)}
                    active={activeId === file.id}
                    onClick={(e) => sel.handleItemClick(e, file.id, start + c)}
                    onDoubleClick={() => sel.handleItemDoubleClick(file.id)}
                    onContextMenu={() => sel.handleItemContextMenu(file.id)}
                  />
                ))}
              </div>
            )
          })}
        </div>

        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-blue-500/40 bg-blue-500/5" />
        )}
      </div>
    </QueueContextMenu>
  )
}

function GridCell({
  file,
  selected,
  active,
  onClick,
  onDoubleClick,
  onContextMenu
}: {
  file: X3FFileDTO
  selected: boolean
  active: boolean
  onClick: (e: MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: () => void
}): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={file.fileName}
      className="flex cursor-default flex-col"
      style={{ height: THUMB_H + LABEL_H }}
    >
      <div
        className={cn(
          'relative rounded-md border',
          selected ? 'border-blue-500/70' : 'border-white/10 hover:border-white/25',
          active && 'ring-2 ring-blue-400/60'
        )}
        style={{ height: THUMB_H }}
      >
        <Thumbnail file={file} className="h-full w-full rounded-md" />
        <div className="absolute right-1 top-1 rounded bg-black/55 p-0.5">
          <StatusIcon file={file} />
        </div>
      </div>
      <span
        className={cn(
          'truncate px-1 pt-1 text-center text-xs',
          selected ? 'text-neutral-100' : 'text-neutral-400'
        )}
      >
        {file.fileName}
      </span>
    </div>
  )
}
