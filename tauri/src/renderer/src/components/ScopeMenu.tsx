import { ChevronDown } from 'lucide-react'
import { SCOPE_MODES, type ScopeMode } from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/strings'
import { NativeMenuButton } from './ui/nativeMenuButton'

export function ScopeMenu(): React.JSX.Element {
  const mode = useSettingsStore((s) => s.settings.inspectorScopeMode)
  const update = useSettingsStore((s) => s.update)

  return (
    <NativeMenuButton
      variant="ghost"
      size="sm"
      className="-my-1.5 ml-auto h-auto min-w-0 gap-1 px-1 py-1.5 text-[10px] font-semibold uppercase leading-normal tracking-wide text-neutral-500"
      aria-label={t('inspector.scope_view')}
      items={SCOPE_MODES.map((value) => ({
        value,
        label: t(`inspector.scope_${value}`),
        checked: value === mode
      }))}
      onSelect={(value) => void update({ inspectorScopeMode: value as ScopeMode })}
    >
      <span className="truncate">{t(`inspector.scope_${mode}`)}</span>
      <ChevronDown className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
    </NativeMenuButton>
  )
}
