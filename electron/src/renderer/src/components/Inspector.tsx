import { previewUrl } from '@shared/preview'
import { useQueueStore } from '../stores/queueStore'
import { useExif } from '../hooks/useExif'
import { t } from '../lib/strings'
import { Histogram } from './Histogram'
import { OrientedImage } from './OrientedImage'

/**
 * Collapsible right sidebar showing the active file's RGB histogram and EXIF
 * metadata. The "active" file is the primary selection (queueStore.activeId);
 * with nothing selected it shows an empty state.
 */
export function Inspector(): React.JSX.Element {
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
            <OrientedImage
              file={active}
              variant="preview"
              containerClassName="h-44 w-full rounded-md border border-white/10 bg-neutral-900"
            />
          </div>

          <Section title={t('inspector.histogram')}>
            <Histogram url={previewUrl(active.path, 'preview')} aspectRatio={active.aspectRatio} />
          </Section>

          <Section title={t('inspector.metadata')}>
            <ExifTable path={active.path} />
          </Section>
        </div>
      )}
    </aside>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-b border-white/10 px-3 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {children}
    </div>
  )
}

function ExifTable({ path }: { path: string }): React.JSX.Element {
  const data = useExif(path)

  if (data === 'loading') {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-3.5 animate-pulse rounded bg-neutral-800/50" />
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
