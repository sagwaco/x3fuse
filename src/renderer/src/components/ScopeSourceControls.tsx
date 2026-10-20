import { Pipette, RectangleHorizontal, Scan } from 'lucide-react'
import { GlassGroup } from './ui/glassGroup'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'

/** The pixels that the scope measures. */
const SCOPE_SOURCES = [
  ['entire', 'scopeEntire', RectangleHorizontal],
  ['visible', 'scopeVisible', Scan]
] as const
export type ScopeSource = (typeof SCOPE_SOURCES)[number][0] | 'qualifier'

/** The Qualifier button and the Entire and Visible group, as in the editor and the inspector. */
export function ScopeSourceControls({
  value,
  onChange,
  zoomable = true
}: {
  value: ScopeSource
  onChange: (next: ScopeSource) => void
  /** False disables Visible and Qualifier, as when no zoomable preview shows. */
  zoomable?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {/* Apart from the group. While it is the source, no group item is selected. */}
      <button
        type="button"
        id="scope-tab-qualifier"
        aria-label={t('editor.scopeQualifier')}
        title={t('editor.scopeQualifier')}
        aria-pressed={value === 'qualifier'}
        disabled={!zoomable}
        onClick={() => onChange('qualifier')}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-md disabled:opacity-40',
          value === 'qualifier'
            ? 'bg-yellow-400 text-neutral-900 enabled:hover:bg-yellow-300'
            : 'text-tone-300 enabled:hover:bg-tone-800'
        )}
      >
        <Pipette aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
      <GlassGroup
        kind="tabs"
        id="scope"
        panelId={() => 'scope-panel'}
        display="icon"
        size="sm"
        aria-label={t('editor.scopeArea')}
        value={value}
        items={SCOPE_SOURCES.map(([item, label, icon]) => ({
          value: item,
          label: t(`editor.${label}`),
          icon,
          disabled: item === 'visible' && !zoomable
        }))}
        onValueChange={onChange}
      />
    </div>
  )
}
