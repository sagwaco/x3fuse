import { useEffect, useMemo } from 'react'
import type { Flag, QueueViewMode, X3FFileDTO } from '@shared/types'
import { NO_FILTER, visibleFiles } from '../lib/culling'
import { shownFiles, useQueueStore, type ExportDraft } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useNavStore, type Screen } from '../stores/navStore'
import { isTextEditing, useEditorStore } from '../stores/editorStore'

/** The photos a queue view shows, in order. An export draft is never filtered. */
export function useShownFiles(draft?: ExportDraft): X3FFileDTO[] {
  const files = useQueueStore((s) => draft?.files ?? s.files)
  const filter = useQueueStore((s) => s.filter)
  const sortField = useSettingsStore((s) => s.settings.sortField)
  const sortAscending = useSettingsStore((s) => s.settings.sortAscending)
  return useMemo(
    () => visibleFiles(files, draft ? NO_FILTER : filter, sortField, sortAscending),
    [draft, files, filter, sortField, sortAscending]
  )
}

/**
 * The photos that a flag or rating applies to. Grid and list use the selection. The editor,
 * filmstrip, and survey use the photo on screen, as in Lightroom's Loupe and Survey views.
 */
export function cullTargets(
  queue: Pick<ReturnType<typeof useQueueStore.getState>, 'files' | 'selectedIds' | 'activeId'>,
  mode: QueueViewMode,
  screen: Screen
): X3FFileDTO[] {
  if (screen === 'editor') {
    const path = useEditorStore.getState().session?.path
    const file =
      queue.files.find((other) => other.id === queue.activeId) ??
      queue.files.find((other) => other.path === path)
    return file ? [file] : []
  }
  const single = mode === 'filmstrip' || mode === 'survey' || !queue.selectedIds.size
  return queue.files.filter((file) =>
    single ? file.id === queue.activeId : queue.selectedIds.has(file.id)
  )
}

/**
 * Flags or rates the cull targets, or `ids` when given. `toggle` clears a flag that every
 * target already has. `advance` then moves to the next shown photo.
 */
export function cull(
  patch: { flag?: Flag; rating?: number },
  {
    advance = false,
    toggle = false,
    ids
  }: { advance?: boolean; toggle?: boolean; ids?: Set<string> } = {}
): void {
  const screen = useNavStore.getState().screen
  const editor = useEditorStore.getState()
  if (screen === 'export' || editor.closing || (screen === 'editor' && editor.cropping)) return
  let queue = useQueueStore.getState()
  const mode = useSettingsStore.getState().settings.queueViewMode
  // Without a cursor, the filmstrip shows its first photo, and the editor its open photo.
  // That photo becomes the cursor, so that advancing starts from it.
  const shown =
    !ids &&
    !queue.activeId &&
    (screen === 'editor'
      ? cullTargets(queue, mode, screen)[0]
      : mode === 'filmstrip' && shownFiles(queue)[0])
  if (shown) {
    queue.setSelection(new Set([shown.id]), shown.id)
    queue = useQueueStore.getState()
  }
  const targets = ids
    ? queue.files.filter((file) => ids.has(file.id))
    : cullTargets(queue, mode, screen)
  if (!targets.length) return
  if (toggle && patch.flag && targets.every((file) => (file.flag ?? 'unflagged') === patch.flag))
    patch = { ...patch, flag: 'unflagged' }
  queue.setCull(new Set(targets.map((file) => file.id)), patch, advance)
}

const VIEW_KEYS: Record<string, QueueViewMode> = { g: 'grid', e: 'filmstrip', n: 'survey' }

/**
 * Lightroom culling keys. Z picks and X rejects; pressing either again clears the flag. U
 * clears it, and 0-5 set the rating. Shift also moves to the next photo. These keys also work
 * in the editor. On the queue screen, G, E, and N change the view, and \ shows the filter bar.
 */
export function useCullingKeys(): void {
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      const screen = useNavStore.getState().screen
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        screen === 'export' ||
        isTextEditing(event.target) ||
        !useQueueStore.getState().files.length ||
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [aria-haspopup="menu"][aria-expanded="true"]'
        )
      )
        return
      const key = event.key.toLowerCase()
      const digit = /^(?:Digit|Numpad)([0-5])$/.exec(event.code)
      const patch =
        key === 'z'
          ? { flag: 'pick' as const }
          : key === 'x'
            ? { flag: 'reject' as const }
            : key === 'u'
              ? { flag: 'unflagged' as const }
              : digit
                ? { rating: Number(digit[1]) }
                : undefined
      if (patch) {
        event.preventDefault()
        cull(patch, { advance: event.shiftKey, toggle: true })
        return
      }
      if (screen !== 'queue') return
      const settings = useSettingsStore.getState()
      if (VIEW_KEYS[key] && !event.shiftKey && settings.loaded) {
        event.preventDefault()
        void settings.update({ queueViewMode: VIEW_KEYS[key] })
      } else if (event.key === '\\') {
        event.preventDefault()
        useQueueStore.getState().toggleFilterBar()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [])
}
