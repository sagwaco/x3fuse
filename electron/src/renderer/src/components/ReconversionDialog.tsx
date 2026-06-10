import * as Dialog from '@radix-ui/react-dialog'
import { FileText, Info, TriangleAlert } from 'lucide-react'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { outputFileName } from '../lib/outputName'
import { parentName } from '../lib/path'
import { t } from '../lib/strings'
import { Button } from './ui/button'

/**
 * Reconversion confirmation (port of ReconversionConfirmationView). Shown when a
 * convert/reconvert action targets files whose output already exists on disk.
 */
export function ReconversionDialog(): React.JSX.Element {
  const pending = useQueueStore((s) => s.pendingReconversion)
  const confirm = useQueueStore((s) => s.confirmReconversion)
  const cancel = useQueueStore((s) => s.cancelReconversion)
  const settings = useSettingsStore((s) => s.settings)

  const open = pending !== null

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex w-[420px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-white/10 bg-neutral-900 p-5 shadow-2xl focus:outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 h-6 w-6 shrink-0 text-orange-400" />
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-base font-semibold text-neutral-50">
                {t('reconversion.title')}
              </Dialog.Title>
              <Dialog.Description className="text-sm text-neutral-400">
                {t('reconversion.message')}
              </Dialog.Description>
            </div>
          </div>

          <div className="max-h-48 overflow-auto rounded-md">
            <div className="flex flex-col gap-1.5">
              {pending?.conflicts.map((file) => (
                <div
                  key={file.id}
                  className="flex items-center gap-2 rounded-md bg-white/5 px-2.5 py-2"
                >
                  <FileText className="h-4 w-4 shrink-0 text-neutral-500" />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-neutral-100">
                      {outputFileName(file, settings)}
                    </span>
                    <span className="truncate text-xs text-neutral-500">
                      {t('reconversion.location_prefix')}
                      {parentName(file.path)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-md bg-blue-500/10 px-3 py-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
            <span className="text-xs text-neutral-400">{t('reconversion.warning')}</span>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="bordered" size="md" onClick={cancel}>
              {t('button.cancel')}
            </Button>
            <Button variant="prominent" size="md" onClick={confirm}>
              {t('button.overwrite')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
