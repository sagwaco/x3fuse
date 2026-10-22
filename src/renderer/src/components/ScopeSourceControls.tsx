import { Pipette } from 'lucide-react'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'

/** The pixels that the scope measures: the entire image, or the Qualifier area. */
export type ScopeSource = 'entire' | 'qualifier'

/** The Qualifier toggle, as in the editor and the inspector. Off measures the entire image. */
export function ScopeSourceControls({
  value,
  onChange,
  zoomable = true
}: {
  value: ScopeSource
  onChange: (next: ScopeSource) => void
  /** False disables turning the Qualifier on, as when no zoomable preview shows. */
  zoomable?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      id="scope-qualifier"
      aria-label={t('editor.scopeQualifier')}
      title={t('editor.scopeQualifier')}
      aria-pressed={value === 'qualifier'}
      disabled={!zoomable && value !== 'qualifier'}
      onClick={() => onChange(value === 'qualifier' ? 'entire' : 'qualifier')}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-md disabled:opacity-40',
        value === 'qualifier'
          ? 'bg-yellow-400 text-neutral-900 enabled:hover:bg-yellow-300'
          : 'text-tone-300 enabled:hover:bg-tone-800'
      )}
    >
      <Pipette aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
    </button>
  )
}
