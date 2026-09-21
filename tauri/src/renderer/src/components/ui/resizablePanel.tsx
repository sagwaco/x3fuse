import { useRef, useState, type ReactNode } from 'react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useElementWidth } from '../../hooks/useElementWidth'
import { useSettingsStore } from '../../stores/settingsStore'
import { t } from '../../lib/strings'
import { ResizeHandle } from './resizeHandle'

export function ResizablePanel({
  kind,
  children
}: {
  kind: 'inspector' | 'export'
  children: ReactNode
}): React.JSX.Element {
  const key = kind === 'inspector' ? 'inspectorWidth' : 'exportPanelWidth'
  const saved = useSettingsStore((state) => state.settings[key])
  const update = useSettingsStore((state) => state.update)
  const [draft, setDraft] = useState<number>()
  const parent = useRef<HTMLElement | null>(null)
  const available = useElementWidth(parent)
  const min = kind === 'inspector' ? 220 : 300
  const max = Math.max(min, Math.min(800, (available || window.innerWidth) - 240))
  const width = Math.max(min, Math.min(max, draft ?? saved))
  const commit = (value: number): void => {
    void update({ [key]: value })
    setDraft(undefined)
  }
  return (
    <aside
      ref={(node) => {
        parent.current = node?.parentElement ?? null
      }}
      className="relative flex shrink-0 flex-col border-l border-white/10 bg-neutral-900/30"
      style={{ width }}
    >
      <ResizeHandle
        label={t('layout.resize_panel', {
          name: t(kind === 'inspector' ? 'inspector.title' : 'export.settings_heading')
        })}
        hint={t('layout.reset_panel')}
        value={width}
        min={min}
        max={max}
        direction={-1}
        onChange={setDraft}
        onCommit={commit}
        onCancel={() => setDraft(undefined)}
        onReset={() => commit(DEFAULT_SETTINGS[key])}
        className="-left-1 inset-y-0"
      />
      {children}
    </aside>
  )
}
