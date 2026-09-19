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
  const showLoading = useDelayedLoading(loading, fileId ?? url)

  const paint = (result: RenderedScope): void => {
    const element = canvas.current
    if (!element) return
    element.width = result.width
    element.height = result.height
    element.getContext('2d')?.drawImage(result, 0, 0)
  }

  // A revisit only copies the already rendered surface before paint.
  useLayoutEffect(() => {
    if (!cached || !key) return
    paint(cached)
    setCompleted(key)
  }, [cached, key])

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
        paint(result)
        setCompleted(key)
      },
      () => setError(key)
    )
  }, [request, key])

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
      {image && image !== 'loading' && !failed ? (
        <canvas
          ref={canvas}
          className={`h-full w-full ${ready ? '' : 'invisible'}`}
          role="img"
          aria-hidden={!ready || undefined}
          aria-label={t(`inspector.scope_${mode}`)}
        />
      ) : !loading ? (
        <p className="flex h-full items-center justify-center text-xs text-neutral-600">
          {t('inspector.no_preview')}
        </p>
      ) : null}
      {showLoading && (
        <div className="absolute inset-0" role="status" aria-label={t('inspector.scope_loading')}>
          <Skeleton className="preview-skeleton h-full w-full" />
        </div>
      )}
    </div>
  )
}
