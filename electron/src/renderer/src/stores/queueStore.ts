import { create } from 'zustand'
import {
  batchSettings,
  type BatchConversionSettings,
  type ConversionStatus,
  type X3FFileDTO
} from '@shared/types'
import type { BatchSummary, IpcEventMap, OutputConflict } from '@shared/ipc'
import { ipc } from '../lib/ipc'
import { basename } from '../lib/path'
import { outputFileName } from '../lib/outputName'
import { sortFiles } from '../lib/sortFiles'
import { useSettingsStore } from './settingsStore'
import { useNavStore } from './navStore'

const newPlaceholderId = (): string => crypto.randomUUID()

export interface ExportDraft {
  files: X3FFileDTO[]
  settings: BatchConversionSettings
}

export interface BatchFileResult {
  file: X3FFileDTO
  outputFileName: string
  status: ConversionStatus | 'cancelled' | 'unstarted'
  progress: number
  message?: string
  outputPath?: string
}

export interface ConversionBatch {
  id: string
  results: BatchFileResult[]
  summary: BatchSummary | null
}

interface QueueState {
  files: X3FFileDTO[]
  selectedIds: Set<string>
  activeId: string | null
  isProcessing: boolean
  isCancelling: boolean
  isPreparing: boolean
  draft: ExportDraft | null
  pendingReconversion: OutputConflict[] | null
  batch: ConversionBatch | null
  error: string | null
  setSelection: (ids: Set<string>, active?: string | null) => void
  selectAll: () => void
  deselectAll: () => void
  addFiles: (paths: string[]) => Promise<void>
  removeFiles: (ids: Set<string>) => void
  removeSelected: () => void
  clearQueue: () => void
  openExport: (ids?: Set<string>) => void
  updateDraft: (patch: Partial<BatchConversionSettings>) => void
  cancelExport: () => void
  commitExport: () => Promise<void>
  convertPrevious: () => Promise<void>
  convertAllMenu: () => void
  applyStatus: (p: IpcEventMap['file:status']) => void
  applyProgress: (p: IpcEventMap['file:progress']) => void
  onBatchStarted: (p: IpcEventMap['batch:started']) => void
  onBatchComplete: (p: BatchSummary) => void
  dismissBatch: () => void
  stop: () => void
  confirmReconversion: () => void
  cancelReconversion: () => void
}

function pickActive(
  ids: Set<string>,
  preferred: string | null | undefined,
  current: string | null
): string | null {
  if (preferred && ids.has(preferred)) return preferred
  if (current && ids.has(current)) return current
  return ids.size > 0 ? (ids.values().next().value as string) : null
}

export const useQueueStore = create<QueueState>((set, get) => {
  function capture(ids: Set<string>): ExportDraft | null {
    const settings = useSettingsStore.getState()
    if (!settings.loaded) return null
    const files = sortFiles(
      get().files.filter((f) => ids.has(f.id)),
      settings.settings.sortField,
      settings.settings.sortAscending
    )
    if (!files.length || files.some((f) => f.pending)) return null
    return { files, settings: batchSettings(settings.settings) }
  }

  function beginConversion(replaceExisting: boolean): void {
    const draft = get().draft
    if (!draft || get().isProcessing) return
    const previousBatch = get().batch
    const batch: ConversionBatch = {
      id: crypto.randomUUID(),
      summary: null,
      results: draft.files.map((file) => ({
        file,
        outputFileName: outputFileName(file, draft.settings),
        status: 'queued',
        progress: 0
      }))
    }
    set({
      batch,
      isProcessing: true,
      isPreparing: true,
      isCancelling: false,
      pendingReconversion: null,
      error: null
    })
    void ipc
      .invoke('convert:start', {
        batchId: batch.id,
        files: draft.files.map(({ id, path }) => ({ id, path })),
        settings: draft.settings,
        replaceExisting
      })
      .catch((error: unknown) => {
        if (get().batch?.id !== batch.id) return
        set({
          isProcessing: false,
          isPreparing: false,
          isCancelling: false,
          error: String(error),
          ...(get().draft ? { batch: previousBatch } : {})
        })
        if (get().draft) useNavStore.getState().goToExport()
      })
  }

  async function checkAndStart(): Promise<void> {
    const draft = get().draft
    if (!draft || get().isProcessing || get().isPreparing) return
    set({ isPreparing: true, error: null })
    try {
      const conflicts = await ipc.invoke('queue:existingOutputs', {
        files: draft.files.map(({ id, path }) => ({ id, path })),
        settings: draft.settings
      })
      if (conflicts.length) set({ pendingReconversion: conflicts })
      else beginConversion(false)
    } catch (error) {
      set({ isPreparing: false, error: String(error) })
    }
  }

  return {
    files: [],
    selectedIds: new Set(),
    activeId: null,
    isProcessing: false,
    isCancelling: false,
    isPreparing: false,
    draft: null,
    pendingReconversion: null,
    batch: null,
    error: null,

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
        pending: true
      }))
      set((s) => ({
        files: [...s.files, ...placeholders],
        // Give the preview and Info panel the same subject on the first import.
        ...(s.files.length === 0
          ? { selectedIds: new Set([placeholders[0].id]), activeId: placeholders[0].id }
          : {})
      }))

      // Hydrate the active preview and visible sort order without waiting for
      // metadata from the entire import before any thumbnail can load.
      const { sortField, sortAscending } = useSettingsStore.getState().settings
      const ordered = sortFiles(placeholders, sortField, sortAscending)
      const activeIndex = ordered.findIndex((file) => file.id === get().activeId)
      if (activeIndex > 0) ordered.unshift(...ordered.splice(activeIndex, 1))

      for (let offset = 0; offset < ordered.length; offset += 8) {
        const survivingIds = new Set(get().files.map((file) => file.id))
        const chunk = ordered.slice(offset, offset + 8).filter((file) => survivingIds.has(file.id))
        if (!chunk.length) continue
        let added: X3FFileDTO[] = []
        try {
          added = await ipc.invoke('queue:add', { paths: chunk.map((file) => file.path) })
        } catch (e) {
          console.error('queue:add failed', e)
        }

        // Fold each chunk into surviving placeholders, keeping selection IDs stable.
        const metaById = new Map<string, X3FFileDTO>()
        added.forEach((dto, i) => {
          const id = chunk[i]?.id
          if (id) metaById.set(id, dto)
        })
        // Failed or missing results only roll back this chunk's optimistic rows.
        const unresolved = new Set(
          chunk.filter((file) => !metaById.has(file.id)).map((file) => file.id)
        )
        set((s) => ({
          selectedIds: new Set([...s.selectedIds].filter((id) => !unresolved.has(id))),
          activeId: s.activeId && unresolved.has(s.activeId) ? null : s.activeId,
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
      }
    },

    removeFiles(ids) {
      if (get().isProcessing || get().isPreparing || get().draft) return
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
      if (get().isProcessing || get().isPreparing || get().draft) return
      set({ files: [], selectedIds: new Set(), activeId: null })
    },

    openExport(ids = get().selectedIds) {
      if (get().isProcessing || get().isPreparing || get().draft) return
      const draft = capture(ids)
      if (!draft) return
      set({ draft, error: null })
      useNavStore.getState().goToExport()
    },

    updateDraft(patch) {
      if (get().isPreparing || get().isProcessing) return
      set((s) => ({
        draft: s.draft ? { ...s.draft, settings: { ...s.draft.settings, ...patch } } : null
      }))
    },

    cancelExport() {
      if (get().isPreparing || get().isProcessing) return
      set({ draft: null, error: null })
      useNavStore.getState().goToQueue()
    },

    commitExport: checkAndStart,

    async convertPrevious() {
      if (
        get().isProcessing ||
        get().isPreparing ||
        get().draft ||
        !useSettingsStore.getState().settings.hasPreviousConversion
      )
        return
      const draft = capture(get().selectedIds)
      if (!draft) return
      set({ draft })
      await checkAndStart()
      // A failed shortcut can be corrected in the ordinary export screen.
      if (get().error) useNavStore.getState().goToExport()
    },

    convertAllMenu() {
      if (get().isProcessing || get().isPreparing || get().draft) return
      get().selectAll()
      get().openExport()
    },

    applyStatus({ batchId, id, status, message, outputPath }) {
      set((s) => {
        if (!s.isProcessing || s.batch?.id !== batchId) return s
        return {
          batch: {
            ...s.batch,
            results: s.batch.results.map((r) =>
              r.file.id !== id
                ? r
                : {
                    ...r,
                    status: status === 'queued' ? 'cancelled' : status,
                    progress: ['completed', 'failed', 'warning'].includes(status) ? 1 : r.progress,
                    message: message ?? r.message,
                    outputPath: outputPath ?? r.outputPath
                  }
            )
          }
        }
      })
    },

    applyProgress({ batchId, id, progress }) {
      set((s) =>
        !s.isProcessing || s.batch?.id !== batchId
          ? s
          : {
              batch: {
                ...s.batch,
                results: s.batch.results.map((r) =>
                  r.file.id === id
                    ? { ...r, progress: Math.max(r.progress, Math.min(1, Math.max(0, progress))) }
                    : r
                )
              }
            }
      )
    },

    onBatchStarted({ batchId, settings }) {
      if (get().batch?.id !== batchId) return
      useSettingsStore.setState((s) => ({
        settings: { ...s.settings, ...settings, hasPreviousConversion: true }
      }))
      set({ draft: null, isPreparing: false })
      useNavStore.getState().goToQueue()
    },

    onBatchComplete(summary) {
      set((s) =>
        s.batch?.id !== summary.batchId
          ? s
          : {
              isProcessing: false,
              isCancelling: false,
              isPreparing: false,
              batch: {
                ...s.batch,
                summary,
                results: s.batch.results.map((r) => ({
                  ...r,
                  status:
                    r.status === 'queued'
                      ? 'unstarted'
                      : r.status === 'processing' && summary.cancelled
                        ? 'cancelled'
                        : r.status
                }))
              }
            }
      )
    },

    dismissBatch() {
      if (!get().isProcessing) set({ batch: null, error: null })
    },

    stop() {
      if (!get().isProcessing || get().isPreparing || get().isCancelling) return
      set({ isCancelling: true })
      const batchId = get().batch?.id
      void ipc.invoke('convert:stop').catch((error: unknown) => {
        if (get().batch?.id === batchId) set({ isCancelling: false, error: String(error) })
      })
    },

    confirmReconversion() {
      if (get().pendingReconversion) beginConversion(true)
    },

    cancelReconversion() {
      set({ pendingReconversion: null, isPreparing: false })
      if (useNavStore.getState().screen === 'queue') set({ draft: null })
    }
  }
})
