import { Film, Grid3x3, List } from 'lucide-react'
import type { QueueViewMode } from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'

const MODES: { mode: QueueViewMode; icon: typeof List; labelKey: string }[] = [
  { mode: 'list', icon: List, labelKey: 'view.list' },
  { mode: 'grid', icon: Grid3x3, labelKey: 'view.grid' },
  { mode: 'filmstrip', icon: Film, labelKey: 'view.filmstrip' }
]

/** Queue-view buttons, shown in the toolbar. */
export function ViewControls({ disabled = false }: { disabled?: boolean }): React.JSX.Element {
  const viewMode = useSettingsStore((s) => s.settings.queueViewMode)
  const update = useSettingsStore((s) => s.update)

  return (
    <div className="flex items-center gap-0.5">
      {MODES.map(({ mode, icon: Icon, labelKey }) => (
        <Button
          key={mode}
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          title={t(labelKey)}
          aria-pressed={viewMode === mode}
          onClick={() => void update({ queueViewMode: mode })}
          className={viewMode === mode ? 'bg-white/15 text-neutral-100' : ''}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </Button>
      ))}
    </div>
  )
}
