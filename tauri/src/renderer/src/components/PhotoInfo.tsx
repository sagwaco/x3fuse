import { Info } from 'lucide-react'
import type { X3FFileDTO } from '@shared/types'
import { useExif } from '../hooks/useExif'
import { cn } from '../lib/cn'
import { t } from '../lib/strings'
import { Tooltip } from './ui/tooltip'

/** The file name, and an info icon that shows the capture details in a card. */
export function PhotoInfo({ file }: { file: X3FFileDTO }): React.JSX.Element {
  return (
    <>
      <span className="truncate" title={file.fileName}>
        {file.fileName}
      </span>
      <Tooltip text={<PhotoCard file={file} />} side="bottom" className="whitespace-normal p-0">
        <button
          type="button"
          aria-label={t('editor.photoInfo')}
          className="shrink-0 cursor-default rounded text-neutral-500 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
    </>
  )
}

function PhotoCard({ file }: { file: X3FFileDTO }): React.JSX.Element {
  const rows = useExif(file.path, file.id, file.exif, file.pending)
  // The labels are the inspector rows from src-tauri/src/metadata.rs.
  const exif = new Map(Array.isArray(rows) ? rows.map((row) => [row.label, row.value]) : [])
  const value = (label: string): string => exif.get(label) ?? '-'
  const exposure = exif.get('Exposure comp.')
  const grid = [
    [
      ['Tv', value('Shutter')],
      ['Av', value('Aperture')]
    ],
    [
      ['ISO', value('ISO')],
      [t('editor.infoFocal'), value('Focal length')],
      [t('editor.infoExposure'), exposure ? `${exposure} EV` : '-']
    ],
    [
      ['WB', value('White balance')],
      [t('editor.infoSize'), value('Dimensions')],
      // The date only, as the time does not fit.
      [t('editor.infoDate'), exif.get('Captured')?.slice(0, 10) ?? '-']
    ]
  ]
  return (
    <div className="w-80 font-mono text-xs">
      <div className="space-y-1.5 p-3">
        <p className="truncate text-neutral-500">{file.fileName}</p>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1 font-sans text-[13px] font-semibold text-neutral-100">
            <p className="truncate">{value('Camera')}</p>
            <p className="truncate">{value('Lens')}</p>
          </div>
          <span className="shrink-0 rounded bg-neutral-300 px-1.5 py-0.5 text-[10px] font-medium text-neutral-900">
            {file.fileName.split('.').pop()?.toUpperCase()}
          </span>
        </div>
      </div>
      {grid.map((cells, row) => (
        <dl
          key={row}
          className={cn(
            'grid divide-x divide-white/15 border-t border-white/15',
            row ? 'grid-cols-3' : 'grid-cols-2'
          )}
        >
          {cells.map(([label, text]) => (
            <div key={label} className="min-w-0 px-3 py-2">
              <dt
                className={cn('text-[10px] tracking-[0.12em] text-neutral-500', row && 'uppercase')}
              >
                {label}
              </dt>
              <dd className={cn('mt-1 truncate text-neutral-100', !row && 'text-2xl')}>{text}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  )
}
