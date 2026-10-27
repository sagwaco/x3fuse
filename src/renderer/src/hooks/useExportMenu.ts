import type { NativeMenuItem } from '@shared/ipc'
import { renderedOnly, useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/strings'

/** The overflow submenu value that opens the Export screen. */
export const EXPORT_SCREEN = 'screen'

/**
 * Exports at once with a preset (`jpeg`, `embeddedJpg`, `dng`, `tiff`) or with the
 * previous settings (`previous`). The default files are the selection.
 */
export function exportWith(
  value: string | undefined,
  ids?: Set<string>,
  returnScreen?: 'queue' | 'editor'
): void {
  const queue = useQueueStore.getState()
  if (value === 'previous') void queue.convertPrevious(ids, returnScreen)
  else if (value === 'jpeg' || value === 'embeddedJpg' || value === 'dng' || value === 'tiff')
    void queue.exportPreset(value, ids, returnScreen)
}

/** The export presets of the split button, and what choosing one does. */
export function useExportMenu(
  ids?: Set<string>,
  returnScreen?: 'queue' | 'editor'
): { items: NativeMenuItem[]; select: (value?: string) => void; openScreen: () => void } {
  const openExport = useQueueStore((s) => s.openExport)
  const hasPrevious = useSettingsStore((s) => s.settings.hasPreviousConversion)
  // A DNG exports only rendered images, so a selection with one has no original formats.
  const hasDng = useQueueStore((s) =>
    s.files.some((file) => (ids ?? s.selectedIds).has(file.id) && renderedOnly(file))
  )
  return {
    items: [
      { value: 'jpeg', label: t('batch.export_jpeg') },
      // The editor offers only formats that include the edit.
      ...(returnScreen === 'editor' || hasDng
        ? []
        : [
            { value: 'embeddedJpg', label: t('editor.exportEmbeddedJpeg') },
            { value: 'dng', label: t('batch.export_dng') }
          ]),
      { value: 'tiff', label: t('batch.export_tiff') },
      { value: 'previous', label: t('batch.convert_previous'), disabled: !hasPrevious }
    ],
    select: (value) => exportWith(value, ids, returnScreen),
    openScreen: () => openExport(ids, returnScreen)
  }
}
