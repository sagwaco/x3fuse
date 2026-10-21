import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useScrollToActive } from '../hooks/useScrollToActive'
import type { X3FFileDTO } from '@shared/types'
import type { PreviewRegion } from '@shared/editor'
import { displayPreviewUrl } from '@shared/preview'
import { useQueueStore, type ExportDraft } from '../stores/queueStore'
import { isTextEditing, useEditorStore } from '../stores/editorStore'
import { runCommand } from '../lib/commands'
import { useScopeSourceStore } from '../stores/scopeSourceStore'
import { qualifySquare } from '../lib/qualifySquare'
import { useFileDrop } from '../hooks/useFileDrop'
import { useQueueSelection, type QueueSelection } from '../hooks/useQueueSelection'
import { useShownFiles } from '../hooks/useCulling'
import { cn } from '../lib/cn'
import { Thumbnail } from './Thumbnail'
import { EditedBadge } from './EditedBadge'
import { CullBadge } from './CullBadge'
import { StackBadge } from './StackBadge'
import { ZoomablePreview } from './ZoomablePreview'
import { QueueContextMenu } from './QueueContextMenu'
import { DevelopingCloud } from '../lib/developingCloud'
import { useLanguage } from '../lib/strings'

/** Filmstrip view: a large preview of the active file above a scrollable strip. */
export function FileFilmstrip({
  draft,
  preview
}: {
  draft?: ExportDraft
  preview?: ReactNode
}): React.JSX.Element {
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const activeId = useQueueStore((s) => s.activeId)
  const sorted = useShownFiles(draft)

  const { isDragOver, dropHandlers } = useFileDrop()
  const sel = useQueueSelection(sorted, { mode: 'horizontal' })
  const rootRef = useRef<HTMLDivElement>(null)

  // The large preview follows the active selection, falling back to the first file.
  const activeIndex = Math.max(
    0,
    sorted.findIndex((f) => f.id === activeId)
  )
  const active = sorted[activeIndex]
  // The strip loads the editor's pixels after the developing cloud leaves.
  const cloud = useContext(DevelopingCloud)
  const editorPreviewUrl = useEditorStore((state) =>
    !cloud && preview !== undefined && state.session?.path === active?.path
      ? state.preview?.url
      : undefined
  )
  // Reuse completed editor pixels; autosaves must not start a separate 2K render.
  const activeThumbnail = useMemo(
    () =>
      active && editorPreviewUrl ? { ...active, displayPreviewUrl: editorPreviewUrl } : active,
    [active, editorPreviewUrl]
  )
  // Focus the surface on mount so arrow-key navigation works without a click.
  useEffect(() => rootRef.current?.focus(), [])

  // The inspector scope measures this preview: its visible part and the Qualifier area.
  const shownId = active?.id
  // Only a painted preview of the one selected photo takes Visible and Qualifier. Its size
  // gives the Qualifier point its shape, also for an edited preview of other geometry.
  // The paint counts only for the preview that the inspector measures. A new preview of the
  // same photo, as after a paste of edits, waits for its own paint.
  const [painted, setPainted] = useState<{
    id: string
    source: string
    url: string
    width: number
    height: number
  } | null>(null)
  const source = active ? displayPreviewUrl(active) : undefined
  const size = painted?.id === shownId && painted.source === source ? painted : null
  const zoomable = !preview && !!active && !active.pending && !!size && selectedIds.size <= 1
  const paintedUrl = size?.url
  // A new preview clears the Qualifier area, which belongs to the pixels that it was set on.
  useEffect(() => {
    if (!zoomable) return
    const { setPreview } = useScopeSourceStore.getState()
    setPreview(shownId ?? null)
    return () => setPreview(null)
  }, [zoomable, shownId, paintedUrl])
  const qualifying = useScopeSourceStore((s) => s.qualifying && s.previewId === shownId)
  const qualified = useScopeSourceStore((s) =>
    s.source === 'qualifier' && s.qualified?.id === shownId ? s.qualified.region : null
  )
  const onViewportChange = useCallback(
    (region: PreviewRegion | null) => {
      if (shownId) useScopeSourceStore.getState().setViewport(shownId, region)
    },
    [shownId]
  )
  const qualify = useCallback(
    (region: PreviewRegion) => {
      if (shownId) useScopeSourceStore.getState().qualify(shownId, region)
    },
    [shownId]
  )
  const disarm = useScopeSourceStore.getState().disarm
  // Escape disarms the Qualifier. Else in the library it goes back to the grid, as in
  // Lightroom. Dialogs, menus, and text fields keep their Escape.
  const library = !draft && preview === undefined
  useEffect(() => {
    if (!qualifying && !library) return
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (qualifying) useScopeSourceStore.getState().disarm()
      else if (!isTextEditing(event.target)) runCommand('viewGrid', { source: 'key' })
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [qualifying, library])

  return (
    <QueueContextMenu disabled={!!draft || preview !== undefined}>
      <div
        ref={rootRef}
        tabIndex={0}
        onKeyDown={sel.handleKeyDown}
        onContextMenu={sel.handleContainerContextMenu}
        {...(draft || preview !== undefined ? {} : dropHandlers)}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      >
        <div
          className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center bg-tone-950"
          onContextMenu={() => active && sel.handleItemContextMenu(active.id)}
        >
          {preview ??
            (active ? (
              // On the queue screen, digits rate the photo as in Lightroom. Click and +/- zoom.
              <ZoomablePreview
                key={active.id}
                file={active}
                digitZoom={!!draft}
                onViewportChange={draft ? undefined : onViewportChange}
                onPaint={(url, { width, height }) =>
                  setPainted({
                    id: active.id,
                    source: displayPreviewUrl(active),
                    url,
                    width,
                    height
                  })
                }
                onSelectionCancel={disarm}
                onImagePoint={
                  qualifying && size
                    ? (x, y) => qualify(qualifySquare(x, y, size.width / size.height))
                    : undefined
                }
                onImageRegion={qualifying ? qualify : undefined}
                outline={qualified}
                selectionKey={active.id}
              />
            ) : null)}
        </div>

        <FilmstripStrip
          files={sorted}
          active={activeThumbnail}
          selectedIds={selectedIds}
          sel={sel}
        />

        {!draft && isDragOver && (
          <div className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-accent/40 bg-accent/5" />
        )}
      </div>
    </QueueContextMenu>
  )
}

type StripHandlers = Pick<
  QueueSelection,
  'handleItemClick' | 'handleItemDoubleClick' | 'handleItemContextMenu'
>

/** A scrolling row of thumbnails. `active` can carry newer pixels for the active photo. */
export function FilmstripStrip({
  files,
  active,
  selectedIds,
  sel
}: {
  files: X3FFileDTO[]
  active?: X3FFileDTO
  selectedIds: Set<string>
  sel: StripHandlers
}): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: files.length,
    horizontal: true,
    getScrollElement: () => stripRef.current,
    estimateSize: () => 84,
    getItemKey: (index) => files[index].id,
    paddingStart: 12,
    paddingEnd: 4,
    scrollPaddingStart: 12,
    scrollPaddingEnd: 12,
    overscan: 4
  })
  useScrollToActive(virtualizer, files, active?.id ?? null)
  return (
    <div
      ref={stripRef}
      data-filmstrip
      className="h-[104px] shrink-0 scroll-px-3 overflow-x-auto overflow-y-hidden border-t border-ink/10 bg-tone-900/40"
    >
      <div className="relative h-full" style={{ width: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const file = files[item.index]
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
                file={file.id === active?.id ? active : file}
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
  sel: StripHandlers
}): React.JSX.Element {
  // Memo skips the parent's render, so this renders again for a new language.
  useLanguage()
  return (
    <div
      onClick={(e) => sel.handleItemClick(e, file.id, index)}
      onDoubleClick={() => sel.handleItemDoubleClick(file.id)}
      onContextMenu={() => sel.handleItemContextMenu(file.id)}
      title={file.fileName}
      className={cn(
        'relative h-[76px] w-[76px] shrink-0 cursor-default overflow-hidden rounded-md border',
        active
          ? 'border-accent ring-2 ring-accent/60'
          : selected
            ? 'border-accent/70'
            : 'border-ink/10 hover:border-ink/25'
      )}
    >
      <Thumbnail
        file={file}
        className={cn('h-full w-full', file.flag === 'reject' && 'opacity-40')}
      />
      <CullBadge file={file} overlay />
      <EditedBadge edit={file.edit} overlay />
      <StackBadge file={file} overlay />
    </div>
  )
})
