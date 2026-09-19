import { previewUrl } from '@shared/preview'
import type { X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { useExif } from '../hooks/useExif'
import { useDelayedLoading } from '../hooks/useDelayedLoading'
import { Skeleton } from '@radix-ui/themes/components/skeleton'
import '@radix-ui/themes/src/components/skeleton.css'
import { t } from '../lib/strings'
import { ColorScope } from './ColorScope'
import { ScopeMenu } from './ScopeMenu'
import { useSettingsStore } from '../stores/settingsStore'
import { PreviewMinimap } from './PreviewMinimap'
import { PanelSection as Section } from './ui/panelSection'

/**
 * Collapsible right sidebar showing the active file's color scope and EXIF
 * metadata. The "active" file is the primary selection (queueStore.activeId);
 * with nothing selected it shows an empty state.
 */
export function Inspector(): React.JSX.Element {
  const scopeMode = useSettingsStore((s) => s.settings.inspectorScopeMode)
  // Select just the active file: its reference only changes when that file's
  // row changes, so other files' progress ticks don't re-render the inspector.
  const active = useQueueStore((s) =>
    s.activeId ? s.files.find((f) => f.id === s.activeId) : undefined
  )

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-white/10 bg-neutral-900/30">
      <div className="flex h-8 shrink-0 items-center border-b border-white/10 px-3 text-xs font-medium text-neutral-400">
        {t('inspector.title')}
      </div>

      {!active ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-neutral-600">
          {t('inspector.no_selection')}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-white/10 px-3 py-2">
            <p className="truncate text-sm text-neutral-200" title={active.fileName}>
              {active.fileName}
            </p>
          </div>

          <div className="border-b border-white/10 p-3">
            <PreviewMinimap key={active.id} file={active} />
          </div>

          <Section title={t('inspector.scopes')} action={<ScopeMenu />}>
            <ColorScope
              url={active.pending ? undefined : previewUrl(active.path, 'preview', active.id)}
              fileId={active.id}
              pending={active.pending}
              aspectRatio={active.aspectRatio}
              orientation={active.orientation}
              mode={scopeMode}
            />
          </Section>

          <Section title={t('inspector.metadata')}>
            <ExifTable file={active} />
          </Section>
        </div>
      )}
    </aside>
  )
}

function ExifTable({ file }: { file: X3FFileDTO }): React.JSX.Element {
  const data = useExif(file.path, file.id, file.exif, file.pending)
  const showLoading = useDelayedLoading(data === 'loading', file.id)

  if (data === 'loading') {
    return (
      <div className="h-[114px] space-y-1.5" aria-busy="true">
        {showLoading &&
          Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="preview-skeleton h-3.5 w-full rounded" />
          ))}
      </div>
    )
  }

  if (!data || data.length === 0) {
    return <p className="text-xs text-neutral-600">{t('inspector.no_metadata')}</p>
  }

  return (
    <dl className="space-y-1.5">
      {data.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3 text-xs">
          <dt className="shrink-0 text-neutral-500">{row.label}</dt>
          <dd className="truncate text-right text-neutral-200" title={row.value}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
