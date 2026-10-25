import { memo, useEffect, useRef } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { useQueueStore, type ExportDraft } from '../stores/queueStore'
import { useFileDrop } from '../hooks/useFileDrop'
import { useQueueSelection, type QueueSelection } from '../hooks/useQueueSelection'
import { useScrollToActive } from '../hooks/useScrollToActive'
import { useVirtualGrid } from '../hooks/useVirtualGrid'
import { useMarquee, type Box } from '../hooks/useMarquee'
import { MarqueeBox } from './ui/marqueeBox'
import { useShownFiles } from '../hooks/useCulling'
import { cn } from '../lib/cn'
import { Thumbnail } from './Thumbnail'
import { CullBadge } from './CullBadge'
import { StackBadge } from './StackBadge'
import { EditErrorBadge } from './EditErrorBadge'
import { QueueContextMenu } from './QueueContextMenu'
import { useLanguage } from '../lib/strings'

const PADDING = 12
const GAP = 12
const MIN_CELL = 150
const THUMB_H = 120
const LABEL_H = 34
const ROW_HEIGHT = THUMB_H + LABEL_H + GAP

/** Thumbnail grid view: virtualized rows of embedded-preview cells. */
export function FileGrid({ draft }: { draft?: ExportDraft }): React.JSX.Element {
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const activeId = useQueueStore((s) => s.activeId)
  const sorted = useShownFiles(draft)

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

  const marquee = useMarquee(parentRef, ({ left, top, right, bottom }: Box) => {
    // Cells fill the padded width in equal columns. Each row is a cell and its label.
    const width = parentRef.current?.clientWidth ?? 0
    const cell = (width - 2 * PADDING - (columns - 1) * GAP) / columns
    const ids: string[] = []
    const rows = Math.ceil(sorted.length / columns)
    for (let row = 0; row < rows; row++) {
      const y = PADDING + row * ROW_HEIGHT
      if (y > bottom || y + THUMB_H + LABEL_H < top) continue
      for (let column = 0; column < columns; column++) {
        const x = PADDING + column * (cell + GAP)
        const file = sorted[row * columns + column]
        if (file && x <= right && x + cell >= left) ids.push(file.id)
      }
    }
    return ids
  })

  return (
    <QueueContextMenu disabled={!!draft}>
      <div
        ref={parentRef}
        onPointerDown={marquee.onPointerDown}
        tabIndex={0}
        onKeyDown={sel.handleKeyDown}
        onContextMenu={sel.handleContainerContextMenu}
        onClick={sel.handleContainerClick}
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
        <MarqueeBox box={marquee.box} />

        {!draft && isDragOver && (
          <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-accent/40 bg-accent/5" />
        )}
      </div>
    </QueueContextMenu>
  )
}

// Keep unchanged cells stable while browsing.
const GridCell = memo(function GridCell({
  file,
  index,
  selected,
  active,
  sel
}: {
  file: X3FFileDTO
  index: number
  selected: boolean
  active: boolean
  sel: QueueSelection
}): React.JSX.Element {
  // Memo skips the parent's render, so this renders again for a new language.
  useLanguage()
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
          'group relative rounded-md border',
          // The offset leaves a clear gap between the image and the outline.
          active
            ? 'border-transparent outline outline-2 outline-offset-2 outline-select'
            : selected
              ? 'border-select/70'
              : 'border-ink/10 hover:border-ink/25'
        )}
        style={{ height: THUMB_H }}
      >
        <Thumbnail
          file={file}
          className={cn('h-full w-full rounded-md', file.flag === 'reject' && 'opacity-40')}
        />
        <CullBadge file={file} overlay />
        <StackBadge file={file} overlay />
        <EditErrorBadge file={file} overlay />
      </div>
      <span
        className={cn(
          'truncate px-1 pt-1 text-center text-xs',
          selected ? 'text-tone-100' : 'text-tone-400'
        )}
      >
        {file.fileName}
      </span>
    </div>
  )
})
