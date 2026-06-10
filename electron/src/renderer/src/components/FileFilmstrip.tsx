import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import type { X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useFileDrop } from '../hooks/useFileDrop'
import { useQueueSelection } from '../hooks/useQueueSelection'
import { sortFiles } from '../lib/sortFiles'
import { cn } from '../lib/cn'
import { StatusIcon } from './StatusIcon'
import { Thumbnail } from './Thumbnail'
import { OrientedImage } from './OrientedImage'
import { QueueContextMenu } from './QueueContextMenu'

/** Filmstrip view: a large preview of the active file above a scrollable strip. */
export function FileFilmstrip(): React.JSX.Element {
  const files = useQueueStore((s) => s.files)
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
  const active = sorted.find((f) => f.id === activeId) ?? sorted[0]

  // Focus the surface on mount so arrow-key navigation works without a click.
  useEffect(() => rootRef.current?.focus(), [])

  return (
    <QueueContextMenu>
      <div
        ref={rootRef}
        tabIndex={0}
        onKeyDown={sel.handleKeyDown}
        onContextMenu={sel.handleContainerContextMenu}
        {...dropHandlers}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      >
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-neutral-950 p-4">
          {active ? <LargePreview file={active} /> : null}
        </div>

        <div className="h-[104px] shrink-0 overflow-x-auto overflow-y-hidden border-t border-white/10 bg-neutral-900/40">
          <div className="flex h-full items-center gap-2 px-3">
            {sorted.map((file, i) => (
              <FilmstripCell
                key={file.id}
                file={file}
                selected={selectedIds.has(file.id)}
                active={active?.id === file.id}
                onClick={(e) => sel.handleItemClick(e, file.id, i)}
                onDoubleClick={() => sel.handleItemDoubleClick(file.id)}
                onContextMenu={() => sel.handleItemContextMenu(file.id)}
              />
            ))}
          </div>
        </div>

        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-blue-500/40 bg-blue-500/5" />
        )}
      </div>
    </QueueContextMenu>
  )
}

/**
 * Large preview of the active file. Requests the full-resolution embedded JPEG
 * (the PreviewService falls back to the smaller preview internally) and applies
 * the file's EXIF orientation.
 */
function LargePreview({ file }: { file: X3FFileDTO }): React.JSX.Element {
  return <OrientedImage file={file} variant="full" containerClassName="h-full w-full" maxEdge={2400} />
}

function FilmstripCell({
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
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [active])

  return (
    <div
      ref={ref}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
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
      <div className="absolute right-0.5 top-0.5 rounded bg-black/55 p-0.5">
        <StatusIcon file={file} />
      </div>
    </div>
  )
}
