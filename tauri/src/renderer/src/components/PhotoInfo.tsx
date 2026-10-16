import { Info, Zap } from 'lucide-react'
import type { X3FFileDTO } from '@shared/types'
import { useExif } from '../hooks/useExif'
import { cn } from '../lib/cn'
import { formatBytes } from '../lib/format'
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
          className="shrink-0 cursor-default rounded text-tone-500 hover:text-tone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
    </>
  )
}

/** The capture details, in the layout of the Photos app info card. */
function PhotoCard({ file }: { file: X3FFileDTO }): React.JSX.Element {
  const rows = useExif(file.path, file.id, file.exif, file.pending)
  // The labels are the inspector rows from src-tauri/src/metadata.rs.
  const exif = new Map(Array.isArray(rows) ? rows.map((row) => [row.label, row.value]) : [])
  // ExifTool writes 4.0 for f/4 and 30.0 mm for 30 mm. Show 4 and 30.
  const number = (label: string): number | undefined => {
    const value = parseFloat(exif.get(label)?.replace('f/', '') ?? '')
    return Number.isFinite(value) ? value : undefined
  }
  const [width, height] = (exif.get('Dimensions') ?? '').split(' × ').map(Number)
  const flash = exif.get('Flash')
  const metering = exif.get('Metering')
  const focal = number('Focal length')
  const aperture = number('Aperture')
  const capture = [
    exif.has('ISO') && `ISO ${exif.get('ISO')}`,
    focal !== undefined && `${focal} mm`,
    exif.has('Exposure comp.') && `${exif.get('Exposure comp.')} ev`,
    aperture !== undefined && `ƒ${aperture}`,
    exif.has('Shutter') && `${exif.get('Shutter')} s`
  ].filter(Boolean)
  return (
    <div className="w-80 text-[13px] text-tone-100">
      <div className="space-y-1 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate">{exif.get('Camera') ?? '-'}</p>
            <p className="truncate">
              {exif.get('Lens') ?? (rows === 'loading' ? '-' : t('editor.noLens'))}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {flash && (
              <span role="img" aria-label={flash} title={flash}>
                <Zap
                  aria-hidden="true"
                  className={cn(
                    'h-4 w-4',
                    flashFired(flash) ? 'text-tone-100' : 'text-tone-600'
                  )}
                />
              </span>
            )}
            {metering && <MeteringIcon mode={metering} />}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 tabular-nums">
          {width > 0 && height > 0 && (
            <>
              <span>{Math.round((width * height) / 1e6)} MP</span>
              <span>
                {width} × {height}
              </span>
            </>
          )}
          {file.fileSize != null && <span>{formatBytes(file.fileSize)}</span>}
          <span className="rounded bg-tone-500 px-1 text-[10px] font-bold leading-4 text-tone-900">
            {file.fileName.split('.').pop()?.toUpperCase()}
          </span>
        </div>
      </div>
      {capture.length > 0 && (
        <div className="flex justify-between gap-3 border-t border-ink/15 px-3 py-2 tabular-nums">
          {capture.map((text) => (
            <span key={String(text)}>{text}</span>
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
