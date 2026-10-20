import { Film, Grid3x3, LayoutDashboard, List } from 'lucide-react'
import type { QueueViewMode } from '@shared/types'
import type { MenuCommand } from '@shared/ipc'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/strings'
import { acceleratorsOf, withShortcut } from '../lib/shortcut'
import { GlassGroup } from './ui/glassGroup'

const MODES: { mode: QueueViewMode; icon: typeof List; labelKey: string; command: MenuCommand }[] =
  [
    { mode: 'list', icon: List, labelKey: 'view.list', command: 'viewList' },
    { mode: 'grid', icon: Grid3x3, labelKey: 'view.grid', command: 'viewGrid' },
    { mode: 'filmstrip', icon: Film, labelKey: 'view.filmstrip', command: 'viewFilmstrip' },
    { mode: 'survey', icon: LayoutDashboard, labelKey: 'view.survey', command: 'viewSurvey' }
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
        ({ mode, icon, labelKey, command }) => ({
          value: mode,
          icon,
          label: t(labelKey),
          title: withShortcut(t(labelKey), command),
          // The view keys are single letters, as ARIA writes them.
          keyshortcuts: acceleratorsOf(command)[0]
        })
      )}
    />
  )
}
