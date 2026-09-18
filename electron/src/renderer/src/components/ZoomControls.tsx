import { ZoomIn, ZoomOut } from 'lucide-react'
import { usePreviewStore } from '../stores/previewStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'

const ZOOM_PRESETS = [25, 50, 75, 100, 125, 150, 175, 200]

export function ZoomControls(): React.JSX.Element {
  const controls = usePreviewStore((state) => state.controls)
  const percent = (controls?.scale ?? 1) * 100
  const zoomValue = controls?.zoom == null ? 'fit' : String(percent)

  return (
    <div role="group" aria-label={t('preview.zoom_controls')} className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        disabled={!controls || controls.scale <= controls.minZoom}
        aria-label={t('preview.zoom_out')}
        title={t('preview.zoom_out')}
        onClick={() => controls?.zoomTo((zoom) => zoom / 1.25)}
      >
        <ZoomOut className="h-4 w-4" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        disabled={!controls || controls.scale >= controls.maxZoom}
        aria-label={t('preview.zoom_in')}
        title={t('preview.zoom_in')}
        onClick={() => controls?.zoomTo((zoom) => zoom * 1.25)}
      >
        <ZoomIn className="h-4 w-4" aria-hidden="true" />
      </Button>
      <select
        disabled={!controls}
        aria-label={t('preview.zoom_level')}
        className="h-8 min-w-20 rounded-md bg-neutral-900 px-2 text-xs text-neutral-100 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 disabled:opacity-50"
        value={zoomValue}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) =>
          controls?.zoomTo(event.target.value === 'fit' ? null : Number(event.target.value) / 100)
        }
      >
        <option value="fit">{t('preview.fit')}</option>
        {ZOOM_PRESETS.map((value) => (
          <option key={value} value={value}>
            {value}%
          </option>
        ))}
        {zoomValue !== 'fit' && !ZOOM_PRESETS.includes(percent) && (
          <option value={zoomValue} disabled>
            {Math.round(percent)}%
          </option>
        )}
      </select>
    </div>
  )
}
