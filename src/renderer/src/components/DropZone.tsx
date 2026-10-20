import { ImageDown } from 'lucide-react'
import { useFileDrop } from '../hooks/useFileDrop'
import { addFilesViaDialog } from '../lib/addFilesViaDialog'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'

/** Empty-queue state: a drop target with one button that opens the import dialog. */
export function DropZone(): React.JSX.Element {
  const { isDragOver, dropHandlers } = useFileDrop()

  return (
    <div className="flex h-full w-full items-center justify-center p-10" {...dropHandlers}>
      <button
        type="button"
        onClick={() => void addFilesViaDialog()}
        className={cn(
          'flex flex-col items-center gap-3 rounded-lg p-4 font-mono text-sm uppercase tracking-[0.12em] transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50',
          isDragOver ? 'text-accent' : 'text-tone-500 hover:text-tone-300'
        )}
      >
        <ImageDown className="h-14 w-14" />
        {t('queue.empty.load')}
      </button>
    </div>
  )
}
