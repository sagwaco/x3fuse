import { Film, Grid3x3, List, PanelRight } from 'lucide-react'
import type { QueueViewMode } from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'

const MODES: { mode: QueueViewMode; icon: typeof List; labelKey: string }[] = [
  { mode: 'list', icon: List, labelKey: 'view.list' },
  { mode: 'grid', icon: Grid3x3, labelKey: 'view.grid' },
  { mode: 'filmstrip', icon: Film, labelKey: 'view.filmstrip' }
]

/** Segmented queue-view switch + info-sidebar toggle, shown in the toolbar. */
export function ViewControls(): React.JSX.Element {
  const viewMode = useSettingsStore((s) => s.settings.queueViewMode)
  const inspectorOpen = useSettingsStore((s) => s.settings.inspectorOpen)
  const update = useSettingsStore((s) => s.update)

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5 rounded-md border border-white/10 p-0.5">
        {MODES.map(({ mode, icon: Icon, labelKey }) => (
          <button
            key={mode}
            type="button"
            title={t(labelKey)}
            aria-pressed={viewMode === mode}
            onClick={() => void update({ queueViewMode: mode })}
            className={cn(
              'rounded p-1 transition-colors',
              viewMode === mode
                ? 'bg-white/15 text-neutral-100'
                : 'text-neutral-400 hover:text-neutral-200'
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>

      <button
        type="button"
        title={t('inspector.toggle')}
        aria-pressed={inspectorOpen}
        onClick={() => void update({ inspectorOpen: !inspectorOpen })}
        className={cn(
          'rounded-md border border-white/10 p-1.5 transition-colors',
          inspectorOpen
            ? 'bg-white/15 text-neutral-100'
            : 'text-neutral-400 hover:text-neutral-200'
        )}
      >
        <PanelRight className="h-4 w-4" />
      </button>
    </div>
  )
}
