import { Film, Grid3x3, LayoutDashboard, List } from 'lucide-react'
import type { QueueViewMode } from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/strings'
import { withShortcut } from '../lib/shortcut'
import { GlassGroup } from './ui/glassGroup'

const MODES: { mode: QueueViewMode; icon: typeof List; labelKey: string; key?: string }[] = [
  { mode: 'list', icon: List, labelKey: 'view.list' },
  { mode: 'grid', icon: Grid3x3, labelKey: 'view.grid', key: 'G' },
  { mode: 'filmstrip', icon: Film, labelKey: 'view.filmstrip', key: 'E' },
  { mode: 'survey', icon: LayoutDashboard, labelKey: 'view.survey', key: 'N' }
]

/** Queue-view buttons, shown in the toolbar. */
export function ViewControls({
  disabled = false,
  exportView = false
}: {
  disabled?: boolean
  exportView?: boolean
}): React.JSX.Element {
  const viewMode = useSettingsStore((s) => s.settings.queueViewMode)
  const update = useSettingsStore((s) => s.update)

  return (
    <GlassGroup
      display="icon"
      aria-label={t('view.mode')}
      disabled={disabled}
      value={exportView && viewMode === 'survey' ? 'grid' : viewMode}
      onValueChange={(mode) => void update({ queueViewMode: mode })}
      items={MODES.filter(({ mode }) => !exportView || mode !== 'survey').map(
        ({ mode, icon, labelKey, key }) => ({
          value: mode,
          icon,
          label: t(labelKey),
          title: key ? withShortcut(t(labelKey), key) : t(labelKey),
          keyshortcuts: key
        })
      )}
    />
  )
}
