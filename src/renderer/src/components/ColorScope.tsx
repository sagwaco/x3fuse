import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Skeleton } from '@radix-ui/themes/components/skeleton'
import '@radix-ui/themes/src/components/skeleton.css'
import type { ScopeMode } from '@shared/types'
import type { PreviewRegion } from '@shared/editor'
import { useScopeImage } from '../hooks/useScopeImage'
import { useElementWidth } from '../hooks/useElementWidth'
import { useDelayedLoading } from '../hooks/useDelayedLoading'
import { useTheme } from '../hooks/useTheme'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'
import {
  cachedScope,
  createScopeRenderer,
  scopeRenderKey,
  type RenderedScope
} from '../lib/scopeRender'
import { scopeLabels } from '../lib/scopeRenderer'
import { SCOPE_PALETTES } from '../lib/scopes'

const ANCHOR = { left: '0', center: '-50%', right: '-100%' }

export function ColorScope({
  url,
  aspectRatio,
  orientation,
  fileId,
  pending = false,
  mode,
  compact = false,
  paused = false,
  region
}: {
  url: string | undefined
  aspectRatio?: number
  orientation?: number
  fileId?: string
  /** Only these pixels, 0 to 1 of the cropped, oriented preview. */
  region?: PreviewRegion | null
  pending?: boolean
  mode: ScopeMode
  /** A tiny copy without states or labels, for a header. */
  compact?: boolean
  /** Keep the last scope and start no new renders, as while it is out of view. */
  paused?: boolean
}): React.JSX.Element {
  const image = useScopeImage(url, aspectRatio, orientation, fileId, region)
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<ReturnType<typeof createScopeRenderer>>()
  const measured = useElementWidth(container)
  // A compact scope renders square and the canvas scales it down.
  const width = compact ? 200 : measured
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1)
  const [completed, setCompleted] = useState<string>()
  const [painted, setPainted] = useState<string>()
  const [error, setError] = useState<string>()
  // The scope draws in colors for the theme surface, so a theme change draws it again.
  const theme = useTheme()
  const request = useMemo(
    () =>
      image && image !== 'loading' && width > 0
        ? { image, mode, width, pixelRatio, theme }
        : undefined,
    [image, mode, width, pixelRatio, theme]
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
    if (paused || !request || !key || cachedScope(key)) return
    setError(undefined)
    return renderer.current!.render(
      request,
      (result) => {
        paint(result, subject)
        setCompleted(key)
      },
      () => setError(key)
    )
  }, [paused, request, key, subject])

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
      className={cn(
        compact
          ? 'relative h-5 w-10 shrink-0 overflow-hidden rounded-sm'
          : 'relative h-[200px] overflow-hidden rounded',
        // In dark mode, the scope is on the panel itself.
        theme !== 'dark' && 'bg-tone-950/60'
      )}
    >
      <canvas
        ref={canvas}
        className={cn(
          'h-full w-full',
          !visible && 'invisible',
          compact && mode === 'vectorscope' && 'object-contain'
        )}
        role="img"
        aria-hidden={compact || !visible || undefined}
        aria-label={t(`inspector.scope_${mode}`)}
      />
      {/* The labels are dim until the pointer is on one. The canvas has the accessible name. */}
      {!compact && visible && (
        <div aria-hidden="true" style={{ color: SCOPE_PALETTES[theme].label }}>
          {scopeLabels(mode, width).map((label) => (
            <span
              key={label.text}
              className={`absolute font-mono text-[9px] leading-none transition-opacity hover:opacity-100 ${theme === 'gray' ? 'opacity-75' : 'opacity-50'}`}
              style={{ left: label.x, top: label.y, translate: `${ANCHOR[label.align]} -50%` }}
            >
              {label.text}
            </span>
          ))}
        </div>
      )}
      {compact
        ? null
        : !visible &&
          !loading && (
            <p className="absolute inset-0 flex items-center justify-center text-xs text-tone-500">
              {t('inspector.no_preview')}
            </p>
          )}
      {showLoading && !compact && (
        <div className="absolute inset-0" role="status" aria-label={t('inspector.scope_loading')}>
          <Skeleton className="preview-skeleton h-full w-full" />
        </div>
      )}
    </div>
  )
}
