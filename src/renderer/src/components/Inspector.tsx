import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { ResizablePanel } from './ui/resizablePanel'
import { displayPreviewUrl, isRenderedPreview } from '@shared/preview'
import { useShallow } from 'zustand/react/shallow'
import type { ExifPair, X3FFileDTO } from '@shared/types'
import { useQueueStore } from '../stores/queueStore'
import { useSelectionExif } from '../hooks/useExif'
import { useDelayedLoading } from '../hooks/useDelayedLoading'
import { Skeleton } from '@radix-ui/themes/components/skeleton'
import '@radix-ui/themes/src/components/skeleton.css'
import { t } from '../lib/strings'
import { ColorScope } from './ColorScope'
import { ScopeMenu } from './ScopeMenu'
import { ScopeSourceControls } from './ScopeSourceControls'
import { areaFor, previewFraming, useScopeSourceStore } from '../stores/scopeSourceStore'
import { useSettingsStore } from '../stores/settingsStore'
import { PreviewMinimap } from './PreviewMinimap'
import { OrientedImage } from './OrientedImage'
import { PanelSection as Section } from './ui/panelSection'
import { CullControls } from './CullControls'
import { PhotoInfo } from './PhotoInfo'

/** Selection previews, scopes for a single image, and shared EXIF metadata. */
export function Inspector(): React.JSX.Element {
  const scopeMode = useSettingsStore((s) => s.settings.inspectorScopeMode)
  const selected = useQueueStore(
    useShallow((s) => s.files.filter((file) => s.selectedIds.has(file.id)))
  )
  const activeId = useQueueStore((s) => s.activeId)
  const active = selected.find((file) => file.id === activeId) ?? selected[0]
  const multiple = selected.length > 1
  // A new Qualifier area needs the zoomable preview of this photo in the filmstrip. The area
  // stays in other views, and the editor shares it, while the photo keeps its framing.
  const zoomable = useScopeSourceStore((s) => !!active && s.previewId === active.id) && !multiple
  const source = useScopeSourceStore((s) => s.source)
  const qualifying = useScopeSourceStore((s) => zoomable && s.qualifying)
  const qualified = useScopeSourceStore((s) => s.qualified)
  const region =
    active && !multiple && source === 'qualifier'
      ? areaFor(qualified, active.path, previewFraming(active))
      : null
  const title = multiple ? t('batch.image_count', { count: selected.length }) : t('inspector.title')

  return (
    <ResizablePanel kind="inspector">
      <div className="flex h-8 shrink-0 items-center border-b border-ink/10 px-3 font-mono text-xs font-medium uppercase tracking-[0.12em] text-tone-400">
        <div className="ml-0.5 flex min-w-0 items-center gap-1.5">
          {active && !multiple ? (
            <PhotoInfo file={active} />
          ) : (
            <span className="truncate" title={title}>
              {title}
            </span>
          )}
        </div>
      </div>

      {!active ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-tone-600">
          {t('inspector.no_selection')}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-ink/10 p-3">
            {multiple ? (
              <PreviewStack files={selected} active={active} />
            ) : (
              <PreviewMinimap key={active.id} file={active} />
            )}
          </div>
          {/* Why the photo could not open or load its edits, such as an unsupported DNG. */}
          {!multiple && active.editError && (
            <div
              role="alert"
              className="flex items-start gap-2 border-b border-ink/10 p-3 text-xs leading-relaxed text-danger"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="min-w-0 flex-1 select-text break-words">{active.editError}</p>
            </div>
          )}
          <CullControls />

          {/* No title: the scope menu names the scope, as in the editor. */}
          <div className="border-b border-ink/10 p-3">
            {multiple ? (
              <p className="py-6 text-center text-xs text-tone-500">
                {t('inspector.scopes_multiple')}
              </p>
            ) : (
              <>
                <div className="mb-2 flex h-[15px] items-center justify-between gap-2">
                  {/* The row has the height of a section title. The buttons overflow it, and the menu text lines up with the panel text. */}
                  <ScopeMenu className="-ml-2.5" />
                  <ScopeSourceControls
                    value={source}
                    onChange={useScopeSourceStore.getState().choose}
                    zoomable={zoomable}
                  />
                </div>
                <ColorScope
                  url={active.pending ? undefined : displayPreviewUrl(active)}
                  fileId={active.id}
                  pending={active.pending}
                  aspectRatio={isRenderedPreview(active) ? undefined : active.aspectRatio}
                  orientation={isRenderedPreview(active) ? 1 : active.orientation}
                  region={region}
                  mode={scopeMode}
                />
                {qualifying && (
                  <p role="status" className="sr-only">
                    {t('editor.scopeQualifyHint')}
                  </p>
                )}
              </>
            )}
          </div>

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
  // The row that was copied last, for a short confirmation. Each copy restarts it.
  const [copied, setCopied] = useState<ExifPair>()
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(undefined), 1200)
    return () => clearTimeout(timer)
  }, [copied])

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
    return <p className="text-xs text-tone-600">{t('inspector.no_metadata')}</p>
  }

  return (
    <dl className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3 text-xs">
          <dt className="shrink-0 text-tone-500">{row.label}</dt>
          {row.common ? (
            <dd className="min-w-0 text-right" aria-live="polite">
              {/* A click copies the value. */}
              <button
                type="button"
                title={`${row.value}\n${t('inspector.copy_value')}`}
                className="max-w-full cursor-default truncate rounded text-tone-200 hover:text-tone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50"
                onClick={() =>
                  // Some WebKitGTK versions have no clipboard API.
                  navigator.clipboard?.writeText(row.value).then(
                    () => setCopied({ label: row.label, value: row.value }),
                    () => undefined
                  )
                }
              >
                {copied?.label === row.label && copied.value === row.value
                  ? t('inspector.copied')
                  : row.value}
              </button>
            </dd>
          ) : (
            <dd className="truncate text-right text-tone-500" title={row.value}>
              {row.value}
            </dd>
          )}
        </div>
      ))}
    </dl>
  )
}
