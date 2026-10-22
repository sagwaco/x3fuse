import { ChevronDown } from 'lucide-react'
import { SCOPE_MODES, type ScopeMode } from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/strings'
import { NativeMenuButton } from './ui/nativeMenuButton'

/** `className` places the menu in its row. */
export function ScopeMenu({ className = '' }: { className?: string }): React.JSX.Element {
  const mode = useSettingsStore((s) => s.settings.inspectorScopeMode)
  const update = useSettingsStore((s) => s.update)

  return (
    <NativeMenuButton
      variant="ghost"
      size="sm"
      className={`control-label h-7 min-w-0 gap-1 px-2.5 font-normal tracking-[0.16em] text-tone-500 ${className}`}
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
