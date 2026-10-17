import { Info } from 'lucide-react'
import type { X3FFileDTO } from '@shared/types'
import { useExif } from '../hooks/useExif'
import { t } from '../lib/strings'
import { PhotoCard } from './PhotoCard'
import { Tooltip } from './ui/tooltip'

/** The file name, and an info icon that shows the capture details in a card. */
export function PhotoInfo({ file }: { file: X3FFileDTO }): React.JSX.Element {
  return (
    <>
      <span className="truncate" title={file.fileName}>
        {file.fileName}
      </span>
      <Tooltip
        text={<PhotoInfoCard file={file} />}
        side="bottom"
        className="photo-info-tooltip whitespace-normal p-0"
      >
        <button
          type="button"
          aria-label={t('editor.photoInfo')}
          className="shrink-0 cursor-default rounded text-tone-500 hover:text-tone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
    </>
  )
}

/** The capture details of one file. */
function PhotoInfoCard({ file }: { file: X3FFileDTO }): React.JSX.Element {
  const rows = useExif(file.path, file.id, file.exif, file.pending)
  return (
    <PhotoCard
      rows={Array.isArray(rows) ? rows : []}
      files={[file]}
      loading={rows === 'loading'}
      className="w-80"
    />
  )
}
