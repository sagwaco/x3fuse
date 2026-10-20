import { Zap } from 'lucide-react'
import type { ExifPair, X3FFileDTO } from '@shared/types'
import { cn } from '../lib/cn'
import { formatBytes } from '../lib/format'
import { t } from '../lib/strings'

/** The capture details of one file, in the layout of the Photos app info card. */
export function PhotoCard({
  rows,
  file,
  loading = false,
  className
}: {
  rows: readonly ExifPair[]
  file: Pick<X3FFileDTO, 'fileName' | 'fileSize'>
  loading?: boolean
  className?: string
}): React.JSX.Element {
  // The labels are the inspector rows from src-tauri/src/metadata.rs.
  const exif = new Map(rows.map((row) => [row.label, row.value]))
  // ExifTool writes 4.0 for f/4 and 30.0 mm for 30 mm. Show 4 and 30.
  const number = (label: string): number | undefined => {
    const value = parseFloat(exif.get(label)?.replace('f/', '') ?? '')
    return Number.isFinite(value) ? value : undefined
  }
  const [width, height] = (exif.get('Dimensions') ?? '').split(' × ').map(Number)
  const dimensions = width > 0 && height > 0
  const flash = exif.get('Flash')
  const metering = exif.get('Metering')
  const focal = number('Focal length')
  const aperture = number('Aperture')
  const capture = (
    [
      ['ISO', exif.has('ISO') && `ISO ${exif.get('ISO')}`],
      ['Focal length', focal !== undefined && `${focal} mm`],
      ['Exposure comp.', exif.has('Exposure comp.') && `${exif.get('Exposure comp.')} ev`],
      ['Aperture', aperture !== undefined && `ƒ${aperture}`],
      ['Shutter', exif.has('Shutter') && `${exif.get('Shutter')} s`]
    ] as const
  ).filter(([, text]) => text)
  const extension = file.fileName.split('.').pop()?.toUpperCase()
  return (
    <div className={cn('text-[13px] text-tone-100', className)}>
      <div className="space-y-1 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate" title={exif.get('Camera')}>
              {exif.get('Camera') ?? '-'}
            </p>
            <p className="truncate" title={exif.get('Lens')}>
              {exif.get('Lens') ?? (loading ? '-' : t('editor.noLens'))}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {flash && (
              <span role="img" aria-label={flash} title={flash}>
                <Zap
                  aria-hidden="true"
                  className={cn('h-4 w-4', flashFired(flash) ? 'text-tone-100' : 'text-tone-600')}
                />
              </span>
            )}
            {metering && <MeteringIcon mode={metering} />}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 tabular-nums">
          {dimensions && (
            <>
              <span>{Math.round((width * height) / 1e6)} MP</span>
              <span>
                {width} × {height}
              </span>
            </>
          )}
          {file.fileSize != null && <span>{formatBytes(file.fileSize)}</span>}
          {extension && (
            <span className="rounded bg-tone-500 px-1 text-[12px] font-bold leading-4 text-tone-900">
              {extension}
            </span>
          )}
        </div>
      </div>
      {capture.length > 0 && (
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-t border-ink/15 px-3 py-2 tabular-nums">
          {capture.map(([label, text]) => (
            <span key={label}>{text}</span>
          ))}
        </div>
      )}
    </div>
  )
}

/** ExifTool writes "Fired" or "On" for a flash that fired, as in "On, Return detected". */
const flashFired = (flash: string): boolean => /Fired|^On(?!, Did not fire)/.test(flash)

/** A frame with marks for the metering area, as on a camera display. */
function MeteringIcon({ mode }: { mode: string }): React.JSX.Element {
  const spot = /spot|partial/i.test(mode)
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={mode}
      className="h-5 w-5 text-tone-400"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <title>{mode}</title>
      <rect x="2" y="4" width="20" height="16" rx="3" />
      {mode === 'Multi-segment' && <rect x="5.5" y="7.5" width="13" height="9" rx="1.5" />}
      {!spot && <circle cx="12" cy="12" r="2.75" />}
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  )
}
