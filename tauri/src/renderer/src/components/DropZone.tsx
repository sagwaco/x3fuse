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
          isDragOver ? 'border-accent bg-accent/5' : 'border-ink/20 hover:border-ink/30'
        )}
      >
        <ImageDown
          className={cn(
            'h-14 w-14 transition-colors',
            isDragOver ? 'text-accent' : 'text-tone-500'
          )}
        />
      </button>

      <div className="flex flex-col items-center gap-1.5 text-center">
        <p className="text-lg font-medium text-tone-300">{t('queue.empty.title')}</p>
        <p
          className={cn(
            'max-w-xs text-sm transition-colors',
            isDragOver ? 'text-accent' : 'text-tone-500'
          )}
        >
          {t('queue.empty.message')}
        </p>
      </div>
    </div>
  )
}
