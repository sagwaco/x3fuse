import { ResizablePanel } from './ui/resizablePanel'
import { displayPreviewUrl, isRenderedPreview } from '@shared/preview'
import { useShallow } from 'zustand/react/shallow'
import type { X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { useSelectionExif } from '../hooks/useExif'
import { useDelayedLoading } from '../hooks/useDelayedLoading'
import { Skeleton } from '@radix-ui/themes/components/skeleton'
import '@radix-ui/themes/src/components/skeleton.css'
import { t } from '../lib/strings'
import { ColorScope } from './ColorScope'
import { ScopeMenu } from './ScopeMenu'
import { useSettingsStore } from '../stores/settingsStore'
import { PreviewMinimap } from './PreviewMinimap'
import { OrientedImage } from './OrientedImage'
import { PanelSection as Section } from './ui/panelSection'

/** Selection previews, scopes for a single image, and shared EXIF metadata. */
export function Inspector(): React.JSX.Element {
  const scopeMode = useSettingsStore((s) => s.settings.inspectorScopeMode)
  const selected = useQueueStore(
    useShallow((s) => s.files.filter((file) => s.selectedIds.has(file.id)))
  )
  const activeId = useQueueStore((s) => s.activeId)
  const active = selected.find((file) => file.id === activeId) ?? selected[0]
  const multiple = selected.length > 1
  const title = multiple ? t('batch.image_count', { count: selected.length }) : active?.fileName

  return (
    <ResizablePanel kind="inspector">
      <div className="flex h-8 shrink-0 items-center border-b border-white/10 px-3 text-xs font-medium text-neutral-400">
        <span className="truncate" title={title}>
          {t('inspector.title')}
          {title ? ` - ${title}` : ''}
        </span>
      </div>

      {!active ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-neutral-600">
          {t('inspector.no_selection')}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-white/10 p-3">
            {multiple ? (
              <PreviewStack files={selected} active={active} />
            ) : (
              <PreviewMinimap key={active.id} file={active} />
            )}
          </div>

          <Section title={t('inspector.scopes')} action={!multiple && <ScopeMenu />}>
            {multiple ? (
              <p className="py-6 text-center text-xs text-neutral-500">
                {t('inspector.scopes_multiple')}
              </p>
            ) : (
              <ColorScope
                url={active.pending ? undefined : displayPreviewUrl(active)}
                fileId={active.id}
                pending={active.pending}
                aspectRatio={isRenderedPreview(active) ? undefined : active.aspectRatio}
                orientation={isRenderedPreview(active) ? 1 : active.orientation}
                mode={scopeMode}
              />
            )}
          </Section>

          <Section title={t('inspector.metadata')}>
            <ExifTable files={selected} />
          </Section>
        </div>
      )}
    </ResizablePanel>
  )
}

function PreviewStack({
  files,
  active
}: {
  files: X3FFileDTO[]
  active: X3FFileDTO
}): React.JSX.Element {
  const previews = [active, ...files.filter((file) => file.id !== active.id)].slice(0, 3)
  return (
    <div
      className="isolate grid h-48 place-items-center"
      role="group"
      aria-label={t('batch.image_count', { count: files.length })}
    >
      {previews.map((file, index) => (
        <div
          key={file.id}
          title={file.fileName}
          className="[grid-area:1/1]"
          style={{
            transform: `rotate(${[0, -8, 6][index]}deg)`,
            zIndex: previews.length - index
          }}
        >
          <OrientedImage
            file={file}
            loading="eager"
            containerClassName="overflow-visible"
            className="h-auto w-auto max-h-40 max-w-[220px] rounded-sm shadow-[0_8px_16px_-4px_rgba(0,0,0,0.65)]"
          />
        </div>
      ))}
    </div>
  )
}

function ExifTable({ files }: { files: X3FFileDTO[] }): React.JSX.Element {
  const data = useSelectionExif(files)
  const showLoading = useDelayedLoading(
    data === 'loading',
    JSON.stringify(files.map((file) => [file.id, file.path]))
  )

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

  const values = data.map((rows) => new Map(rows.map(({ label, value }) => [label, value])))
  const labels = [...new Set(data.flatMap((rows) => rows.map((row) => row.label)))]
  const rows = labels.map((label) => {
    const value = values[0].get(label)
    const common = value !== undefined && values.every((entry) => entry.get(label) === value)
    return {
      label,
      value: common ? value : t('inspector.multiple_values'),
      common
    }
  })
  if (rows.length === 0) {
    return <p className="text-xs text-neutral-600">{t('inspector.no_metadata')}</p>
  }

  return (
    <dl className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3 text-xs">
          <dt className="shrink-0 text-neutral-500">{row.label}</dt>
          <dd
            className={`truncate text-right ${row.common ? 'text-neutral-200' : 'text-neutral-500'}`}
            title={row.value}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
