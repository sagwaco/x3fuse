import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, PanelRight } from 'lucide-react'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { BatchProgress } from './BatchProgress'
import { Button } from './ui/button'
import { ViewControls } from './ViewControls'
import { ZoomControls } from './ZoomControls'
import { useSettingsStore } from '../stores/settingsStore'

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

  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()
  const dropdownRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!canConvert) setMenuOpen(false)
  }, [canConvert])

  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 px-3">
      <div className="flex items-center gap-3">
        <span className="text-xs tabular-nums text-neutral-500">
          {fileCount > 0 ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'}` : ''}
        </span>
        {fileCount > 0 && (
          <>
            <ViewControls />
            <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-white/15" />
            <ZoomControls />
          </>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <BatchProgress />
        <div
          role="group"
          aria-label={t('batch.convert_options')}
          className="relative flex shrink-0 items-center rounded-md"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setMenuOpen(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && menuOpen) {
              e.preventDefault()
              setMenuOpen(false)
              dropdownRef.current?.focus()
            }
          }}
        >
          <Button
            variant="prominent"
            size="sm"
            className="rounded-r-none"
            disabled={!canConvert}
            onClick={() => openExport()}
            title={t('toolbar.convert_selected')}
          >
            {t('button.convert')}
          </Button>
          <Button
            ref={dropdownRef}
            variant="prominent"
            size="sm"
            className="rounded-l-none border-l border-white/20 px-1.5"
            disabled={!canConvert}
            aria-label={t('batch.convert_options')}
            aria-haspopup="menu"
            aria-expanded={menuOpen && canConvert}
            aria-controls={menuId}
            onClick={() => setMenuOpen(!menuOpen)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && canConvert) {
                e.preventDefault()
                setMenuOpen(true)
              }
            }}
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Button>
          {menuOpen && canConvert && (
            <div
              id={menuId}
              role="menu"
              aria-label={t('batch.convert_options')}
              className="absolute right-0 top-full z-30 mt-1 w-max rounded-md border border-white/15 bg-neutral-900 p-1 shadow-xl"
            >
              <button
                autoFocus
                type="button"
                role="menuitem"
                aria-disabled={!hasPrevious}
                className="rounded px-3 py-2 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 aria-disabled:opacity-40"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.preventDefault()
                }}
                onClick={() => {
                  if (!hasPrevious) return
                  setMenuOpen(false)
                  dropdownRef.current?.focus()
                  void convertPrevious()
                }}
              >
                {t('batch.convert_previous')}
              </button>
            </div>
          )}
        </div>
        {fileCount > 0 && (
          <Button
            variant="ghost"
            size="icon"
            title={t('inspector.toggle')}
            aria-label={t('inspector.toggle')}
            aria-pressed={inspectorOpen}
            className={inspectorOpen ? 'bg-white/15 text-neutral-100' : ''}
            onClick={() => void updateSettings({ inspectorOpen: !inspectorOpen })}
          >
            <PanelRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  )
}
