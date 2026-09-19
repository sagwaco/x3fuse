import { memo, useEffect, useMemo, useRef } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { useQueueStore, type ExportDraft } from '../stores/queueStore'
import { outputFileName } from '../lib/outputName'
import { useSettingsStore } from '../stores/settingsStore'
import { useFileDrop } from '../hooks/useFileDrop'
import { useQueueSelection, type QueueSelection } from '../hooks/useQueueSelection'
import { useScrollToActive } from '../hooks/useScrollToActive'
import { useVirtualGrid } from '../hooks/useVirtualGrid'
import { sortFiles } from '../lib/sortFiles'
import { cn } from '../lib/cn'
import { Thumbnail } from './Thumbnail'
import { QueueContextMenu } from './QueueContextMenu'

const PADDING = 12
const GAP = 12
const MIN_CELL = 150
const THUMB_H = 120
const LABEL_H = 34
const ROW_HEIGHT = THUMB_H + LABEL_H + GAP

/** Thumbnail grid view: virtualized rows of embedded-preview cells. */
export function FileGrid({ draft }: { draft?: ExportDraft }): React.JSX.Element {
  const files = useQueueStore((s) => draft?.files ?? s.files)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const activeId = useQueueStore((s) => s.activeId)
  const sortField = useSettingsStore((s) => s.settings.sortField)
  const sortAscending = useSettingsStore((s) => s.settings.sortAscending)

  const sorted = useMemo(
    () => sortFiles(files, sortField, sortAscending),
    [files, sortField, sortAscending]
  )

  const parentRef = useRef<HTMLDivElement>(null)
  const { isDragOver, dropHandlers } = useFileDrop()
  const { columns, virtualizer } = useVirtualGrid(parentRef, sorted.length, {
    padding: PADDING,
    gap: GAP,
    minCell: MIN_CELL,
    rowHeight: ROW_HEIGHT
  })
  const sel = useQueueSelection(sorted, { mode: 'grid', columns })

  // Focus the surface on mount so arrow-key navigation works without a click.
  useEffect(() => parentRef.current?.focus(), [])

  useScrollToActive(virtualizer, sorted, activeId, columns)

  return (
    <QueueContextMenu disabled={!!draft}>
      <div
        ref={parentRef}
        tabIndex={0}
        onKeyDown={sel.handleKeyDown}
        onContextMenu={sel.handleContainerContextMenu}
        {...(draft ? {} : dropHandlers)}
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
                    outputName={draft ? outputFileName(file, draft.settings) : undefined}
                    index={start + c}
                    selected={selectedIds.has(file.id)}
                    active={activeId === file.id}
                    sel={sel}
                  />
                ))}
              </div>
            )
          })}
        </div>

        {!draft && isDragOver && (
          <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-blue-500/40 bg-blue-500/5" />
        )}
      </div>
    </QueueContextMenu>
  )
}

// Keep unchanged cells stable while browsing.
const GridCell = memo(function GridCell({
  file,
  outputName,
  index,
  selected,
  active,
  sel
}: {
  file: X3FFileDTO
  outputName?: string
  index: number
  selected: boolean
  active: boolean
  sel: QueueSelection
}): React.JSX.Element {
  return (
    <div
      onClick={(e) => sel.handleItemClick(e, file.id, index)}
      onDoubleClick={() => sel.handleItemDoubleClick(file.id)}
      onContextMenu={() => sel.handleItemContextMenu(file.id)}
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
      </div>
      <span
        className={cn(
          'truncate px-1 pt-1 text-center text-xs',
          selected ? 'text-neutral-100' : 'text-neutral-400'
        )}
      >
        {file.fileName}
      </span>
      {outputName && (
        <span className="truncate px-1 text-center text-xs text-neutral-200" title={outputName}>
          → {outputName}
        </span>
      )}
    </div>
  )
})
