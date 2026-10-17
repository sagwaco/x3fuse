import { useEffect, useId } from 'react'
import { Layers } from 'lucide-react'
import { useEditorStore } from '../stores/editorStore'
import { useQueueStore } from '../stores/queueStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'

/** How often the dialog reads the merge progress. */
const POLL = 300

/**
 * Covers the edit controls of an X3I that has not merged. It asks to merge the
 * frames, then shows the progress. The merge continues when the photo closes,
 * so the dialog shows its progress again when the photo opens again.
 */
export function X3iDialog(): React.JSX.Element | null {
  const x3i = useEditorStore((state) => state.x3i)
  const processX3i = useEditorStore((state) => state.processX3i)
  const cancelX3i = useEditorStore((state) => state.cancelX3i)
  const loading = useEditorStore((state) => state.loading)
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing) || loading
  const running = x3i?.progress !== undefined
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void useEditorStore.getState().refreshX3i(true), POLL)
    return () => clearInterval(timer)
  }, [running])
  const title = useId()
  const message = useId()
  if (!x3i || x3i.processed) return null
  const percent = Math.round((x3i.progress ?? 0) * 100)
  return (
    // Below the sidebar header, so the photo info stays available.
    <div className="absolute inset-x-0 bottom-0 top-8 z-10 flex justify-center bg-tone-950/50 px-4 pt-10">
      <div
        role="dialog"
        aria-labelledby={title}
        aria-describedby={message}
        className="h-fit w-full max-w-72 rounded-xl border border-ink/15 bg-tone-900 p-4 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]"
      >
        <h2 id={title} className="flex items-center gap-2 text-sm font-medium text-tone-100">
          <Layers aria-hidden="true" className="h-4 w-4 text-tone-400" />
          {t('editor.x3iTitle')}
        </h2>
        <p id={message} className="mt-2 text-xs leading-relaxed text-tone-400">
          {t('editor.x3iMessage', { frames: x3i.frames })}
        </p>
        {running ? (
          <>
            <div
              role="progressbar"
              aria-label={t('editor.x3iMerging')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="mt-4 h-1.5 overflow-hidden rounded-full bg-ink/10"
            >
              <div
                className="h-full rounded-full bg-ink transition-[width] duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="mt-2 flex justify-between text-[11px] tabular-nums text-tone-400">
              <span>{t('editor.x3iMerging')}</span>
              <span aria-hidden="true">{percent}%</span>
            </p>
            <Button
              variant="bordered"
              size="sm"
              className="mt-3 w-full justify-center"
              onClick={cancelX3i}
            >
              {t('button.cancel')}
            </Button>
          </>
        ) : (
          <>
            {x3i.error && (
              <p role="alert" className="mt-3 text-xs text-danger">
                {x3i.error}
              </p>
            )}
            <Button
              variant="prominent"
              size="sm"
              className="mt-4 w-full justify-center"
              disabled={busy}
              onClick={processX3i}
            >
              {t(x3i.error ? 'editor.retry' : 'editor.x3iProcess')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
