import { useEffect } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, PanelRight } from 'lucide-react'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { BatchProgress } from './BatchProgress'
import { Button } from './ui/button'
import { ViewControls } from './ViewControls'
import { ZoomControls } from './ZoomControls'
import { useSettingsStore } from '../stores/settingsStore'
import { useDropdownMenuState } from '../hooks/useDropdownMenuState'

/** Browsing controls, conversion status, and the split Convert button. */
export function Toolbar(): React.JSX.Element {
  const fileCount = useQueueStore((s) => s.files.length)
  const isProcessing = useQueueStore((s) => s.isProcessing)
  const files = useQueueStore((s) => s.files)
  const selectedIds = useQueueStore((s) => s.selectedIds)
  const selected = files.filter((f) => selectedIds.has(f.id))
  const openExport = useQueueStore((s) => s.openExport)
  const isPreparing = useQueueStore((s) => s.isPreparing)
  const hasDraft = useQueueStore((s) => s.draft !== null)
  const convertPrevious = useQueueStore((s) => s.convertPrevious)
  const loaded = useSettingsStore((s) => s.loaded)
  const hasPrevious = useSettingsStore((s) => s.settings.hasPreviousConversion)
  const inspectorOpen = useSettingsStore((s) => s.settings.inspectorOpen)
  const updateSettings = useSettingsStore((s) => s.update)

  const canConvert =
    loaded &&
    selected.length > 0 &&
    !selected.some((f) => f.pending) &&
    !isProcessing &&
    !isPreparing &&
    !hasDraft

  const [menuOpen, setMenuOpen] = useDropdownMenuState()
  useEffect(() => {
    if (!canConvert) setMenuOpen(false)
  }, [canConvert, setMenuOpen])

  return (
    <div className="window-toolbar flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-3">
      <div className="flex items-center gap-3">
        <span className="text-xs tabular-nums text-neutral-500">
          {fileCount > 0 ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'}` : ''}
        </span>
        <ViewControls disabled={fileCount === 0} />
        <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-white/15" />
        <ZoomControls />
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <BatchProgress />
        <div
          role="group"
          aria-label={t('batch.convert_options')}
          className="flex shrink-0 items-center rounded-md bg-white/5"
        >
          <Button
            variant="ghost"
            size="md"
            className="px-2 rounded-r-none text-xs border-l border-t border-b border-white/10"
            disabled={!canConvert}
            onClick={() => openExport()}
            title={t('toolbar.convert_selected')}
          >
            {t('button.convert')}
          </Button>
          <DropdownMenu.Root open={menuOpen && canConvert} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenu.Trigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="w-6 rounded-l-none border-r border-t border-b border-white/10"
                disabled={!canConvert}
                aria-label={t('batch.convert_options')}
              >
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                aria-label={t('batch.convert_options')}
                className="toolbar-dropdown z-30 w-max rounded-md border border-white/15 bg-neutral-900 p-1 text-neutral-100 shadow-xl outline-none [-webkit-app-region:no-drag]"
              >
                <DropdownMenu.Item
                  disabled={!hasPrevious}
                  className="rounded px-3 py-2 text-sm outline-none data-[highlighted]:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
                  onSelect={() => void convertPrevious()}
                >
                  {t('batch.convert_previous')}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        <Button
          variant="ghost"
          size="icon"
          disabled={fileCount === 0}
          title={t('inspector.toggle')}
          aria-label={t('inspector.toggle')}
          aria-pressed={inspectorOpen}
          className={inspectorOpen ? 'bg-white/15 text-neutral-100' : ''}
          onClick={() => void updateSettings({ inspectorOpen: !inspectorOpen })}
        >
          <PanelRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
