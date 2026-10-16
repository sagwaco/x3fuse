import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { X } from 'lucide-react'
import { shownFiles, useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { isTextEditing } from '../stores/editorStore'
import { useShownFiles } from '../hooks/useCulling'
import { successor, surveyColumns } from '../lib/culling'
import { arrowTargetIndex } from '../lib/queueNavigation'
import { cn } from '../lib/cn'
import { t } from '../lib/strings'
import { CullBadge } from './CullBadge'
import { FilmstripImage } from './FilmstripImage'
import { FilmstripStrip } from './FileFilmstrip'
import { QueueContextMenu } from './QueueContextMenu'
import { Thumbnail } from './Thumbnail'

// ponytail: a hard cap keeps canvas memory bounded. Virtualize tiles if larger surveys matter.
const MAX_PHOTOS = 24
/** Larger surveys use the small embedded previews; their tiles are small. */
const FIT_PHOTOS = 6
const GAP = 8
/** A longer Space press shows the photo only until the key is released. */
const HOLD_MS = 300

/** Makes a survey photo active, and adds it to the survey when it is not in it. */
function focusPhoto(id: string): void {
  const { selectedIds, setSelection } = useQueueStore.getState()
  setSelection(new Set([...selectedIds, id]), id)
}

/** Removes a photo from the survey only. Its flag and rating do not change. */
function removePhoto(id: string): void {
  const state = useQueueStore.getState()
  const next = new Set(state.selectedIds)
  next.delete(id)
  const order = shownFiles(state)
    .map((file) => file.id)
    .filter((other) => state.selectedIds.has(other))
  state.setSelection(next, state.activeId === id ? successor(order, id, next) : state.activeId)
}

function openInFilmstrip(id: string): void {
  useQueueStore.getState().setSelection(new Set([id]), id)
  void useSettingsStore.getState().update({ queueViewMode: 'filmstrip' })
}

// Click adds a thumbnail to the survey or makes it active. Cmd/Ctrl-click removes it.
const STRIP = {
  handleItemClick: (event: MouseEvent, id: string): void => {
    if ((event.metaKey || event.ctrlKey) && useQueueStore.getState().selectedIds.has(id))
      removePhoto(id)
    else focusPhoto(id)
  },
  handleItemDoubleClick: openInFilmstrip,
  handleItemContextMenu: focusPhoto
}

/**
 * Tiles the selected photos side by side, as in Lightroom's Survey view. The strip adds
 * photos. Space shows the hovered or active photo over the whole window.
 */
export function SurveyView(): React.JSX.Element {
  const shown = useShownFiles()
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const activeId = useQueueStore((s) => s.activeId)
  const photos = useMemo(
    () => shown.filter((file) => selectedIds.has(file.id)),
    [shown, selectedIds]
  )
  const active = photos.find((file) => file.id === activeId)
  const root = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const hovered = useRef<string | null>(null)
  const [peek, setPeek] = useState(false)
  const peekRef = useRef({ shown: false, since: 0 })
  const [size, setSize] = useState({ width: 0, height: 0 })
  // A photo that leaves the survey stops being shown.
  if (peek && !active) {
    peekRef.current.shown = false
    setPeek(false)
  }
  useEffect(() => {
    root.current?.focus()
    const element = area.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Space works while the survey has focus, or nothing does, so it never presses a button.
  useEffect(() => {
    const show = (shown: boolean): void => {
      peekRef.current = { shown, since: performance.now() }
      setPeek(shown)
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && peekRef.current.shown) {
        event.preventDefault()
        show(false)
        return
      }
      const target = event.target as Element
      if (
        event.key !== ' ' ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTextEditing(target) ||
        (target !== document.body && !root.current?.contains(target)) ||
        // A focused control, such as a tile's remove button, keeps Space.
        (target !== root.current &&
          !!target.closest?.('button, a, [role="button"], [role="slider"]'))
      )
        return
      event.preventDefault()
      if (event.repeat) return
      if (peekRef.current.shown) return show(false)
      const state = useQueueStore.getState()
      const id = hovered.current ?? state.activeId
      if (!id || !state.selectedIds.has(id)) return
      // The shown photo is active, so culling keys apply to it.
      state.setSelection(state.selectedIds, id)
      show(true)
    }
    const keyup = (event: KeyboardEvent): void => {
      if (
        event.key === ' ' &&
        peekRef.current.shown &&
        performance.now() - peekRef.current.since > HOLD_MS
      )
        show(false)
    }
    // A menu or another window can take the key release.
    const blur = (): void => show(false)
    document.addEventListener('keydown', keydown)
    document.addEventListener('keyup', keyup)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('keydown', keydown)
      document.removeEventListener('keyup', keyup)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // Portrait photos (orientation 5-8) are taller than their stored aspect ratio.
  const aspect =
    photos.reduce((sum, file) => {
      const ratio = file.aspectRatio ?? 1.5
      return sum + ((file.orientation ?? 1) >= 5 ? 1 / ratio : ratio)
    }, 0) / (photos.length || 1)
  const columns = surveyColumns(photos.length, size.width, size.height, aspect || 1.5)
  const message = !photos.length
    ? t('survey.empty')
    : photos.length > MAX_PHOTOS
      ? t('survey.too_many', { max: MAX_PHOTOS })
      : null

  return (
    <QueueContextMenu>
      <div
        ref={root}
        tabIndex={0}
        aria-label={t('view.survey')}
        onKeyDown={(event) => {
          if (event.defaultPrevented || message) return
          const index = photos.findIndex((file) => file.id === activeId)
          const target = arrowTargetIndex(
            index,
            event.key,
            { mode: 'grid', columns },
            photos.length
          )
          if (target === null) return
          event.preventDefault()
          useQueueStore.getState().setSelection(selectedIds, photos[target].id)
        }}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      >
        <div ref={area} className="min-h-0 flex-1 p-3">
          {message ? (
            <p className="flex h-full items-center justify-center text-sm text-tone-400">
              {message}
            </p>
          ) : (
            <div
              className="grid h-full w-full"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${Math.ceil(photos.length / columns)}, minmax(0, 1fr))`,
                gap: GAP
              }}
            >
              {photos.map((file) => (
                <div
                  key={file.id}
                  title={file.fileName}
                  onClick={() => focusPhoto(file.id)}
                  onDoubleClick={() => openInFilmstrip(file.id)}
                  onContextMenu={() => focusPhoto(file.id)}
                  onPointerEnter={() => (hovered.current = file.id)}
                  onPointerLeave={() => (hovered.current = null)}
                  className={cn(
                    'group relative min-h-0 min-w-0 cursor-default rounded-md border p-1',
                    file.id === activeId
                      ? 'border-accent ring-2 ring-accent/60'
                      : 'border-ink/10 hover:border-ink/25'
                  )}
                >
                  {photos.length <= FIT_PHOTOS ? (
                    <FilmstripImage
                      file={file}
                      containerClassName={cn(
                        'h-full w-full',
                        file.flag === 'reject' && 'opacity-40'
                      )}
                    />
                  ) : (
                    <Thumbnail
                      file={file}
                      className={cn('h-full w-full', file.flag === 'reject' && 'opacity-40')}
                    />
                  )}
                  <CullBadge file={file} overlay />
                  <button
                    type="button"
                    aria-label={t('survey.remove')}
                    title={t('survey.remove')}
                    onClick={(event) => {
                      event.stopPropagation()
                      removePhoto(file.id)
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    className="absolute right-1 top-1 rounded bg-tone-950/80 p-1 text-tone-200 opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <X aria-hidden="true" className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <FilmstripStrip files={shown} active={active} selectedIds={selectedIds} sel={STRIP} />
        {peek && active && (
          <div
            role="dialog"
            aria-label={active.fileName}
            onClick={() => {
              peekRef.current.shown = false
              setPeek(false)
            }}
            className="fixed inset-0 z-50 flex bg-tone-950 p-3"
          >
            {/* The centered Fit image matches the window. The full-size layer is not centered here. */}
            <FilmstripImage key={active.id} file={active} containerClassName="h-full w-full" />
          </div>
        )}
      </div>
    </QueueContextMenu>
  )
}
