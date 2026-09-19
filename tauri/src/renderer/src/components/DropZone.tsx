import { ImageDown } from 'lucide-react'
import { useFileDrop } from '../hooks/useFileDrop'
import { addFilesViaDialog } from '../lib/addFilesViaDialog'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'

/**
 * Empty-queue state (port of DropZoneView): a dashed drop target with a
 * download-photo glyph, click-to-browse, plus the localized empty title/message.
 */
export function DropZone(): React.JSX.Element {
  const { isDragOver, dropHandlers } = useFileDrop()

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-6 p-10"
      {...dropHandlers}
    >
      <button
        type="button"
        onClick={() => void addFilesViaDialog()}
        className={cn(
          'flex h-52 w-52 items-center justify-center rounded-xl transition-colors',
          'border-4 border-dashed',
          isDragOver ? 'border-blue-500 bg-blue-500/5' : 'border-white/20 hover:border-white/30'
        )}
      >
        <ImageDown
          className={cn(
            'h-14 w-14 transition-colors',
            isDragOver ? 'text-blue-400' : 'text-neutral-500'
          )}
        />
      </button>

      <div className="flex flex-col items-center gap-1.5 text-center">
        <p className="text-lg font-medium text-neutral-300">{t('queue.empty.title')}</p>
        <p
          className={cn(
            'max-w-xs text-sm transition-colors',
            isDragOver ? 'text-blue-400' : 'text-neutral-500'
          )}
        >
          {t('queue.empty.message')}
        </p>
      </div>
    </div>
  )
}
