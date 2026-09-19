import { memo, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useScrollToActive } from '../hooks/useScrollToActive'
import type { X3FFileDTO } from '@shared/types'
import { useQueueStore, type ExportDraft } from '../stores/queueStore'
import { outputFileName } from '../lib/outputName'
import { useSettingsStore } from '../stores/settingsStore'
import { useFileDrop } from '../hooks/useFileDrop'
import { useQueueSelection, type QueueSelection } from '../hooks/useQueueSelection'
import { sortFiles } from '../lib/sortFiles'
import { cn } from '../lib/cn'
import { Thumbnail } from './Thumbnail'
import { ZoomablePreview } from './ZoomablePreview'
import { QueueContextMenu } from './QueueContextMenu'

/** Filmstrip view: a large preview of the active file above a scrollable strip. */
export function FileFilmstrip({ draft }: { draft?: ExportDraft }): React.JSX.Element {
  const files = useQueueStore((s) => draft?.files ?? s.files)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const activeId = useQueueStore((s) => s.activeId)
  const sortField = useSettingsStore((s) => s.settings.sortField)
  const sortAscending = useSettingsStore((s) => s.settings.sortAscending)

  const sorted = useMemo(
    () => sortFiles(files, sortField, sortAscending),
    [files, sortField, sortAscending]
  )

  const { isDragOver, dropHandlers } = useFileDrop()
  const sel = useQueueSelection(sorted, { mode: 'horizontal' })
  const rootRef = useRef<HTMLDivElement>(null)

  // The large preview follows the active selection, falling back to the first file.
  const activeIndex = Math.max(
    0,
    sorted.findIndex((f) => f.id === activeId)
  )
  const active = sorted[activeIndex]
  const stripRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: sorted.length,
    horizontal: true,
    getScrollElement: () => stripRef.current,
    estimateSize: () => 84,
    getItemKey: (index) => sorted[index].id,
    paddingStart: 12,
    paddingEnd: 4,
    scrollPaddingStart: 12,
    scrollPaddingEnd: 12,
    overscan: 4
  })
  useScrollToActive(virtualizer, sorted, active?.id ?? null)
  // Focus the surface on mount so arrow-key navigation works without a click.
  useEffect(() => rootRef.current?.focus(), [])

  return (
    <QueueContextMenu disabled={!!draft}>
      <div
        ref={rootRef}
        tabIndex={0}
        onKeyDown={sel.handleKeyDown}
        onContextMenu={sel.handleContainerContextMenu}
        {...(draft ? {} : dropHandlers)}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      >
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-neutral-950">
          {active ? <ZoomablePreview key={active.id} file={active} /> : null}
        </div>

        {draft && active && (
          <p className="truncate px-3 py-1 text-center text-xs text-neutral-300">
            {active.fileName} → {outputFileName(active, draft.settings)}
          </p>
        )}

        <div
          ref={stripRef}
          data-filmstrip
          className="h-[104px] shrink-0 scroll-px-3 overflow-x-auto overflow-y-hidden border-t border-white/10 bg-neutral-900/40"
        >
          <div className="relative h-full" style={{ width: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const file = sorted[item.index]
              return (
                <div
                  key={file.id}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 14,
                    transform: `translateX(${item.start}px)`
                  }}
                >
                  <FilmstripCell
                    file={file}
                    index={item.index}
                    selected={selectedIds.has(file.id)}
                    active={active?.id === file.id}
                    sel={sel}
                  />
                </div>
              )
            })}
          </div>
        </div>

        {!draft && isDragOver && (
          <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-blue-500/40 bg-blue-500/5" />
        )}
      </div>
    </QueueContextMenu>
  )
}

// Keep unchanged cells stable while browsing.
const FilmstripCell = memo(function FilmstripCell({
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
  return (
    <div
      onClick={(e) => sel.handleItemClick(e, file.id, index)}
      onDoubleClick={() => sel.handleItemDoubleClick(file.id)}
      onContextMenu={() => sel.handleItemContextMenu(file.id)}
      title={file.fileName}
      className={cn(
        'relative h-[76px] w-[76px] shrink-0 cursor-default overflow-hidden rounded-md border',
        active
          ? 'border-blue-400 ring-2 ring-blue-400/60'
          : selected
            ? 'border-blue-500/70'
            : 'border-white/10 hover:border-white/25'
      )}
    >
      <Thumbnail file={file} className="h-full w-full" />
    </div>
  )
})
