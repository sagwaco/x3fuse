import type { NativeMenuItem } from '@shared/ipc'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/strings'

/** The overflow submenu value that opens the Export screen. */
export const EXPORT_SCREEN = 'screen'

/** The export presets of the split button, and what choosing one does. */
export function useExportMenu(
  ids?: Set<string>,
  returnScreen?: 'queue' | 'editor'
): { items: NativeMenuItem[]; select: (value?: string) => void; openScreen: () => void } {
  const openExport = useQueueStore((s) => s.openExport)
  const convertPrevious = useQueueStore((s) => s.convertPrevious)
  const exportPreset = useQueueStore((s) => s.exportPreset)
  const hasPrevious = useSettingsStore((s) => s.settings.hasPreviousConversion)
  return {
    items: [
      { value: 'jpeg', label: t('batch.export_jpeg') },
      // The editor offers only formats that include the edit.
      ...(returnScreen === 'editor'
        ? []
        : [
            { value: 'embeddedJpg', label: t('editor.exportEmbeddedJpeg') },
            { value: 'dng', label: t('batch.export_dng') }
          ]),
      { value: 'tiff', label: t('batch.export_tiff') },
      { value: 'previous', label: t('batch.convert_previous'), disabled: !hasPrevious }
    ],
    select: (value) => {
      if (value === 'previous') void convertPrevious(ids, returnScreen)
      else if (value === 'jpeg' || value === 'embeddedJpg' || value === 'dng' || value === 'tiff')
        void exportPreset(value, ids, returnScreen)
    },
    openScreen: () => openExport(ids, returnScreen)
  }
}
