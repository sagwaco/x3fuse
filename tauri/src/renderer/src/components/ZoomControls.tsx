import { ChevronDown, ZoomIn, ZoomOut } from 'lucide-react'
import { usePreviewStore } from '../stores/previewStore'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'
import { Button } from './ui/button'
import { NativeMenuButton } from './ui/nativeMenuButton'

const ZOOM_PRESETS = [25, 50, 75, 100, 125, 150, 175, 200]

export function ZoomControls(): React.JSX.Element {
  const controls = usePreviewStore((state) => state.controls)
  const activeFileId = usePreviewStore((state) => state.activeFileId)
  // Loading blocks zoom actions without dimming the toolbar between images.
  const loadingClass = activeFileId !== null && !controls ? 'disabled:opacity-100' : undefined
  const percent = (controls?.scale ?? 1) * 100
  const zoomValue = controls?.zoom == null ? 'fit' : String(percent)
  const customZoom = zoomValue !== 'fit' && !ZOOM_PRESETS.includes(percent)
  const zoomOptions = ['fit', ...ZOOM_PRESETS.map(String), ...(customZoom ? [zoomValue] : [])]
  return (
    <div role="group" aria-label={t('preview.zoom_controls')} className="flex items-center gap-0">
      <Button
        variant="ghost"
        size="icon"
        className={loadingClass}
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
        className={loadingClass}
        disabled={!controls || controls.scale >= controls.maxZoom}
        aria-label={t('preview.zoom_in')}
        title={t('preview.zoom_in')}
        onClick={() => controls?.zoomTo((zoom) => zoom * 1.25)}
      >
        <ZoomIn className="h-4 w-4" aria-hidden="true" />
      </Button>
      <NativeMenuButton
        key={controls?.fileId ?? 'unavailable'}
        variant="ghost"
        size="md"
        disabled={!controls}
        aria-label={t('preview.zoom_level')}
        className={cn(
          'min-w-10 justify-between gap-1 px-2 text-xs font-normal tabular-nums',
          loadingClass
        )}
        items={zoomOptions.map((value) => ({
          value,
          label: value === 'fit' ? t('preview.fit') : `${Math.round(Number(value))}%`,
          checked: value === zoomValue,
          disabled: customZoom && value === zoomValue
        }))}
        onSelect={(value) => controls?.zoomTo(value === 'fit' ? null : Number(value) / 100)}
      >
        {zoomValue === 'fit' ? t('preview.fit') : `${Math.round(percent)}%`}
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </NativeMenuButton>
    </div>
  )
}
