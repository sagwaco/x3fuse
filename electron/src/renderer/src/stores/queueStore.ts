import { create } from 'zustand'
import type { ConversionStatus, X3FFileDTO } from '@shared/types'
import type { ConvertFile } from '@shared/ipc'
import { ipc } from '../lib/ipc'
import { basename } from '../lib/path'
import { isQueued, isReconvertable } from '../lib/fileStatus'

/** Mint a stable client-side id for an optimistic placeholder row. */
const newPlaceholderId = (): string => crypto.randomUUID()

/** Files queued for reconversion confirmation (the Radix dialog reads this). */
interface PendingReconversion {
  /** Files whose output already exists (shown in the dialog). */
  conflicts: X3FFileDTO[]
  /** The full set to convert once confirmed (may include non-conflicting files). */
  targets: X3FFileDTO[]
}

interface QueueState {
  files: X3FFileDTO[]
  selectedIds: Set<string>
  /** The "primary" selection — the inspector + filmstrip preview subject. */
  activeId: string | null
  isProcessing: boolean
  isCancelling: boolean
  pendingReconversion: PendingReconversion | null

  // Selection
  setSelection: (ids: Set<string>, active?: string | null) => void
  selectAll: () => void
  deselectAll: () => void

  // Queue management
  addFiles: (paths: string[]) => Promise<void>
  removeFiles: (ids: Set<string>) => void
  removeSelected: () => void
  clearQueue: () => void
  removeFailed: () => void
  removeCompleted: () => void

  // Event-driven updates (from main)
  applyStatus: (p: {
    id: string
    status: ConversionStatus
    message?: string
    outputPath?: string
  }) => void
  applyProgress: (p: { id: string; progress: number }) => void
  onBatchComplete: () => void

  // Conversion triggers (ported from ContentView / FileProcessor)
  convertToolbar: () => Promise<void>
  convertAllMenu: () => Promise<void>
  convertSelected: (ids: Set<string>) => Promise<void>
  reconvertSelected: (ids: Set<string>) => Promise<void>
  doubleClickConvert: (ids: Set<string>) => Promise<void>
  stop: () => void
  confirmReconversion: () => void
  cancelReconversion: () => void
}

const toConvertFile = (f: X3FFileDTO): ConvertFile => ({
  id: f.id,
  path: f.path,
  overrides: f.overrides
})

/**
 * Resolve the active (primary) id after a selection change: prefer the caller's
 * pick, then keep the current one if still selected, else the first selected,
 * else none.
 */
function pickActive(
  ids: Set<string>,
  preferred: string | null | undefined,
  current: string | null
): string | null {
  if (preferred && ids.has(preferred)) return preferred
  if (current && ids.has(current)) return current
  return ids.size > 0 ? (ids.values().next().value as string) : null
}

const canCancelNow = (s: QueueState): boolean => s.isProcessing && !s.isCancelling

export const useQueueStore = create<QueueState>((set, get) => {
  /** Reset the given files to `queued`, then start a sequential conversion. */
  function beginConversion(targets: X3FFileDTO[]): void {
    if (get().isProcessing || targets.length === 0) return
    const targetIds = new Set(targets.map((f) => f.id))
    set((s) => ({
      pendingReconversion: null,
      isProcessing: true,
      isCancelling: false,
      files: s.files.map((f) =>
        targetIds.has(f.id)
          ? { ...f, status: 'queued', progress: 0, errorMessage: undefined, warningMessage: undefined }
          : f
      )
    }))
    ipc
      .invoke('convert:start', { files: targets.map(toConvertFile) })
      .catch((e: unknown) => console.error('convert:start failed', e))
  }

  /**
   * If any target is already converted and its output exists, surface the
   * reconversion dialog (over the conflicts) before starting; otherwise begin.
   * On confirm we convert the *full* target set — unlike the Swift app, which
   * dropped non-conflicting files; converting them is what "Convert All" implies.
   */
  async function startWithReconversionCheck(targets: X3FFileDTO[]): Promise<void> {
    if (get().isProcessing || targets.length === 0) return
    const reconvertable = targets.filter(isReconvertable)
    if (reconvertable.length > 0) {
      const conflictIds = await ipc.invoke('queue:existingOutputs', {
        files: reconvertable.map(toConvertFile)
      })
      const conflictSet = new Set(conflictIds)
      const conflicts = reconvertable.filter((f) => conflictSet.has(f.id))
      if (conflicts.length > 0) {
        set({ pendingReconversion: { conflicts, targets } })
        return
      }
    }
    beginConversion(targets)
  }

  const byIds = (ids: Set<string>): X3FFileDTO[] => get().files.filter((f) => ids.has(f.id))

  return {
    files: [],
    selectedIds: new Set(),
    activeId: null,
    isProcessing: false,
    isCancelling: false,
    pendingReconversion: null,

    setSelection: (ids, active) =>
      set((s) => ({ selectedIds: ids, activeId: pickActive(ids, active, s.activeId) })),
    selectAll: () =>
      set((s) => {
        const ids = new Set(s.files.map((f) => f.id))
        return { selectedIds: ids, activeId: pickActive(ids, undefined, s.activeId) }
      }),
    deselectAll: () => set({ selectedIds: new Set(), activeId: null }),

    async addFiles(paths) {
      // Match main's filter so placeholders line up positionally with the DTOs
      // it returns (it builds them from the same .x3f subset, in the same order).
      const x3f = paths.filter((p) => p.toLowerCase().endsWith('.x3f'))
      if (x3f.length === 0) return

      // Show rows the instant files are dropped: the filename is known from the
      // path; size/date/orientation arrive when `queue:add` resolves.
      const placeholders: X3FFileDTO[] = x3f.map((path) => ({
        id: newPlaceholderId(),
        path,
        fileName: basename(path),
        status: 'queued',
        progress: 0,
        pending: true
      }))
      const placeholderIds = placeholders.map((p) => p.id)
      set((s) => ({ files: [...s.files, ...placeholders] }))

      let added: X3FFileDTO[]
      try {
        added = await ipc.invoke('queue:add', { paths: x3f })
      } catch (e) {
        console.error('queue:add failed', e)
        // Roll back the optimistic rows (and any selection of them) on failure.
        const stale = new Set(placeholderIds)
        set((s) => ({
          files: s.files.filter((f) => !stale.has(f.id)),
          selectedIds: new Set([...s.selectedIds].filter((id) => !stale.has(id))),
          activeId: s.activeId && stale.has(s.activeId) ? null : s.activeId
        }))
        return
      }

      // Fold the freshly-read metadata into each placeholder, keeping its id so
      // selection survives, and clearing `pending`. We merge into the *live* row
      // rather than replacing it so a status/progress the row may have gained
      // mid-import (e.g. the user converted it) isn't clobbered back to queued.
      const metaById = new Map<string, X3FFileDTO>()
      added.forEach((dto, i) => {
        const id = placeholderIds[i]
        if (id) metaById.set(id, dto)
      })
      // Any placeholders main didn't return for (shouldn't happen) get dropped.
      const unresolved = new Set(placeholderIds.filter((id) => !metaById.has(id)))
      set((s) => ({
        files: s.files.flatMap((f) => {
          if (unresolved.has(f.id)) return []
          const dto = metaById.get(f.id)
          if (!dto) return [f]
          return [
            {
              ...f,
              fileSize: dto.fileSize,
              capturedDate: dto.capturedDate,
              orientation: dto.orientation,
              aspectRatio: dto.aspectRatio,
              pending: false
            }
          ]
        })
      }))
    },

    removeFiles(ids) {
      if (get().isProcessing) return
      set((s) => ({
        files: s.files.filter((f) => !ids.has(f.id)),
        selectedIds: new Set([...s.selectedIds].filter((id) => !ids.has(id))),
        activeId: s.activeId && ids.has(s.activeId) ? null : s.activeId
      }))
    },

    removeSelected() {
      get().removeFiles(get().selectedIds)
    },

    clearQueue() {
      if (get().isProcessing) return
      set({ files: [], selectedIds: new Set(), activeId: null })
    },

    removeFailed() {
      if (get().isProcessing) return
      const drop = new Set(get().files.filter((f) => f.status === 'failed').map((f) => f.id))
      get().removeFiles(drop)
    },

    removeCompleted() {
      if (get().isProcessing) return
      const drop = new Set(
        get()
          .files.filter((f) => f.status === 'completed' || f.status === 'warning')
          .map((f) => f.id)
      )
      get().removeFiles(drop)
    },

    applyStatus({ id, status, message, outputPath }) {
      set((s) => ({
        files: s.files.map((f) => {
          if (f.id !== id) return f
          const next: X3FFileDTO = { ...f, status }
          if (status === 'failed') next.errorMessage = message
          if (status === 'warning') next.warningMessage = message
          if (status === 'completed') {
            next.progress = 1
            if (outputPath) next.outputPath = outputPath
          }
          if (status === 'queued') next.progress = 0
          return next
        })
      }))
    },

    applyProgress({ id, progress }) {
      set((s) => ({
        files: s.files.map((f) => (f.id === id ? { ...f, progress } : f))
      }))
    },

    onBatchComplete() {
      set({ isProcessing: false, isCancelling: false })
    },

    // --- Conversion triggers ---

    async convertToolbar() {
      const { files, selectedIds, isProcessing } = get()
      if (isProcessing) return
      if (selectedIds.size > 0) {
        const selected = files.filter((f) => selectedIds.has(f.id))
        if (selected.some(isReconvertable)) await startWithReconversionCheck(selected)
        else beginConversion(selected)
      } else {
        if (files.some(isReconvertable)) await startWithReconversionCheck(files)
        else beginConversion(files.filter(isQueued))
      }
    },

    async convertAllMenu() {
      if (get().isProcessing) return
      // The menu command bypasses the reconversion dialog (matches Swift
      // processAllFiles) and honours onlyProcessNewItems, read fresh from main.
      const settings = await ipc.invoke('settings:get')
      const { files } = get()
      const targets = settings.onlyProcessNewItems ? files.filter(isQueued) : files
      beginConversion(targets)
    },

    async convertSelected(ids) {
      beginConversion(byIds(ids))
    },

    async reconvertSelected(ids) {
      await startWithReconversionCheck(byIds(ids))
    },

    async doubleClickConvert(ids) {
      if (get().isProcessing) return
      const target = byIds(ids)
      if (target.length === 0) return
      if (target.some(isReconvertable)) await startWithReconversionCheck(target)
      else beginConversion(target)
    },

    stop() {
      if (!canCancelNow(get())) return
      set({ isCancelling: true })
      ipc.invoke('convert:stop').catch((e: unknown) => console.error('convert:stop failed', e))
    },

    confirmReconversion() {
      const pending = get().pendingReconversion
      if (!pending) return
      beginConversion(pending.targets)
    },

    cancelReconversion() {
      set({ pendingReconversion: null })
    }
  }
})
