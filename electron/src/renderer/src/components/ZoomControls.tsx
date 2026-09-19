import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useEffect } from 'react'
import { Check, ChevronDown, ZoomIn, ZoomOut } from 'lucide-react'
import { usePreviewStore } from '../stores/previewStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { useDropdownMenuState } from '../hooks/useDropdownMenuState'

const ZOOM_PRESETS = [25, 50, 75, 100, 125, 150, 175, 200]

export function ZoomControls(): React.JSX.Element {
  const controls = usePreviewStore((state) => state.controls)
  const percent = (controls?.scale ?? 1) * 100
  const zoomValue = controls?.zoom == null ? 'fit' : String(percent)
  const customZoom = zoomValue !== 'fit' && !ZOOM_PRESETS.includes(percent)
  const zoomOptions = ['fit', ...ZOOM_PRESETS.map(String), ...(customZoom ? [zoomValue] : [])]
  const [menuOpen, setMenuOpen] = useDropdownMenuState()

  useEffect(() => setMenuOpen(false), [controls?.fileId, setMenuOpen])

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
      <DropdownMenu.Root open={menuOpen && !!controls} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenu.Trigger asChild disabled={!controls}>
          <Button
            variant="ghost"
            size="md"
            aria-label={t('preview.zoom_level')}
            className="min-w-10 justify-between gap-1 px-2 text-xs font-normal tabular-nums"
            onKeyDown={(event) => event.stopPropagation()}
          >
            {zoomValue === 'fit' ? t('preview.fit') : `${Math.round(percent)}%`}
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            aria-label={t('preview.zoom_level')}
            onKeyDown={(event) => event.stopPropagation()}
            className="toolbar-dropdown z-30 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-24 overflow-y-auto rounded-md border border-white/15 bg-neutral-900 p-1 text-neutral-100 shadow-xl outline-none [-webkit-app-region:no-drag]"
          >
            <DropdownMenu.RadioGroup
              value={zoomValue}
              onValueChange={(value) =>
                controls?.zoomTo(value === 'fit' ? null : Number(value) / 100)
              }
            >
              {zoomOptions.map((value) => (
                <DropdownMenu.RadioItem
                  key={value}
                  value={value}
                  disabled={customZoom && value === zoomValue}
                  className="relative rounded py-2 pl-7 pr-3 text-sm tabular-nums outline-none data-[highlighted]:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
                >
                  <DropdownMenu.ItemIndicator className="absolute left-2 top-1/2 -translate-y-1/2">
                    <Check className="h-4 w-4" aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                  {value === 'fit' ? t('preview.fit') : `${Math.round(Number(value))}%`}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}
