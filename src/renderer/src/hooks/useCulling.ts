import { useMemo } from 'react'
import type { Flag, QueueViewMode, X3FFileDTO } from '@shared/types'
import { NO_FILTER, visibleFiles } from '../lib/culling'
import { shownFiles, useQueueStore, type ExportDraft } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useNavStore, type Screen } from '../stores/navStore'
import { useEditorStore } from '../stores/editorStore'

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

/** The photos to flag or rate now, or `ids` when given. None while flags cannot change. */
function cullFiles(ids?: Set<string>): X3FFileDTO[] {
  const screen = useNavStore.getState().screen
  const editor = useEditorStore.getState()
  if (screen === 'export' || editor.closing || (screen === 'editor' && editor.cropping)) return []
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
  return ids ? queue.files.filter((file) => ids.has(file.id)) : cullTargets(queue, mode, screen)
}

/**
 * Flags or rates the cull targets, or `ids` when given. `toggle` clears a flag that every
 * target already has. `advance` then moves to the next shown photo. Returns false when
 * nothing can change.
 */
export function cull(
  patch: { flag?: Flag; rating?: number },
  {
    advance = false,
    toggle = false,
    ids
  }: { advance?: boolean; toggle?: boolean; ids?: Set<string> } = {}
): boolean {
  const targets = cullFiles(ids)
  if (!targets.length) return false
  if (toggle && patch.flag && targets.every((file) => (file.flag ?? 'unflagged') === patch.flag))
    patch = { ...patch, flag: 'unflagged' }
  useQueueStore.getState().setCull(new Set(targets.map((file) => file.id)), patch, advance)
  return true
}

/**
 * Moves the rating of each cull target one star up or down, from 0 to 5. The targets can
 * have different ratings, so each new rating is a separate change.
 */
export function stepRating(step: 1 | -1, advance = false): boolean {
  const targets = cullFiles()
  if (!targets.length) return false
  const groups = new Map<number, Set<string>>()
  for (const file of targets) {
    const rating = Math.max(0, Math.min(5, (file.rating ?? 0) + step))
    groups.set(rating, (groups.get(rating) ?? new Set()).add(file.id))
  }
  // Only the last change advances, so that the cursor moves once.
  const changes = [...groups]
  changes.forEach(([rating, ids], index) =>
    useQueueStore.getState().setCull(ids, { rating }, advance && index === changes.length - 1)
  )
  return true
}
