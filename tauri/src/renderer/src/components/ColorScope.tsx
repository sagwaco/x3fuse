import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Skeleton } from '@radix-ui/themes/components/skeleton'
import '@radix-ui/themes/src/components/skeleton.css'
import type { ScopeMode } from '@shared/types'
import { useScopeImage } from '../hooks/useScopeImage'
import { useElementWidth } from '../hooks/useElementWidth'
import { useDelayedLoading } from '../hooks/useDelayedLoading'
import { t } from '../lib/strings'
import {
  cachedScope,
  createScopeRenderer,
  scopeRenderKey,
  type RenderedScope
} from '../lib/scopeRender'

export function ColorScope({
  url,
  aspectRatio,
  orientation,
  fileId,
  pending = false,
  mode
}: {
  url: string | undefined
  aspectRatio?: number
  orientation?: number
  fileId?: string
  pending?: boolean
  mode: ScopeMode
}): React.JSX.Element {
  const image = useScopeImage(url, aspectRatio, orientation, fileId)
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<ReturnType<typeof createScopeRenderer>>()
  const width = useElementWidth(container)
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1)
  const [completed, setCompleted] = useState<string>()
  const [painted, setPainted] = useState<string>()
  const [error, setError] = useState<string>()
  const request = useMemo(
    () =>
      image && image !== 'loading' && width > 0 ? { image, mode, width, pixelRatio } : undefined,
    [image, mode, width, pixelRatio]
  )
  const key = request ? scopeRenderKey(request) : undefined
  const cached = key ? cachedScope(key) : undefined
  const ready = !!key && (!!cached || completed === key)
  const failed = !!key && error === key
  const loading = pending || image === 'loading' || (!!image && !ready && !failed)
  // Edits and zooming re-render the same file: keep its last scope on the persistent
  // canvas until the next one paints instead of blanking it for every slider step.
  const subject = fileId && `${fileId}:${mode}`
  const holding = loading && !!subject && painted === subject
  const visible = (ready && !failed) || holding
  const showLoading = useDelayedLoading(loading, fileId ?? url) && !holding

  const paint = (result: RenderedScope, shown?: string): void => {
    const element = canvas.current
    if (!element) return
    element.width = result.width
    element.height = result.height
    element.getContext('2d')?.drawImage(result, 0, 0)
    setPainted(shown)
  }

  // A revisit only copies the already rendered surface before paint.
  useLayoutEffect(() => {
    if (!cached || !key) return
    paint(cached, subject)
    setCompleted(key)
  }, [cached, key, subject])

  useEffect(() => {
    const engine = createScopeRenderer()
    renderer.current = engine
    return () => engine.dispose()
  }, [])

  useEffect(() => {
    if (!request || !key || cachedScope(key)) return
    setError(undefined)
    return renderer.current!.render(
      request,
      (result) => {
        paint(result, subject)
        setCompleted(key)
      },
      () => setError(key)
    )
  }, [request, key, subject])

  useEffect(() => {
    // Width changes arrive through ResizeObserver. A window resize only matters
    // here when moving between displays changes the backing pixel density.
    const updateRatio = (): void => setPixelRatio(window.devicePixelRatio || 1)
    window.addEventListener('resize', updateRatio)
    return () => window.removeEventListener('resize', updateRatio)
  }, [])

  return (
    <div
      ref={container}
      aria-busy={loading}
      className="relative h-[200px] overflow-hidden rounded bg-neutral-950/60"
    >
      <canvas
        ref={canvas}
        className={`h-full w-full ${visible ? '' : 'invisible'}`}
        role="img"
        aria-hidden={!visible || undefined}
        aria-label={t(`inspector.scope_${mode}`)}
      />
      {!visible && !loading && (
        <p className="absolute inset-0 flex items-center justify-center text-xs text-neutral-600">
          {t('inspector.no_preview')}
        </p>
      )}
      {showLoading && (
        <div className="absolute inset-0" role="status" aria-label={t('inspector.scope_loading')}>
          <Skeleton className="preview-skeleton h-full w-full" />
        </div>
      )}
    </div>
  )
}
