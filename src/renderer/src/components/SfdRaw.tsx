import { useEffect } from 'react'
import { Info, Trash2, X } from 'lucide-react'
import { usesSfd, type EditRecipe } from '@shared/editor'
import { needsX3iMerge, useEditorStore } from '../stores/editorStore'
import { useQueueStore } from '../stores/queueStore'
import { formatBytes } from '../lib/format'
import { t } from '../lib/strings'
import { SfdCube } from './SfdCube'
import { Button } from './ui/button'
import { ToggleRow } from './ui/settingsLayout'
import { Tooltip } from './ui/tooltip'

/** How often the section reads the merge progress. */
const POLL = 300

function useBusy(): boolean {
  const loading = useEditorStore((state) => state.loading)
  return useQueueStore((state) => state.isProcessing || state.isPreparing) || loading
}

/** An info icon in the SFD RAW section title. Its popover tells what an SFD RAW is. */
export function SfdRawInfo(): React.JSX.Element {
  return (
    <Tooltip
      side="left"
      className="export-help-tooltip max-w-[min(18rem,var(--radix-tooltip-content-available-width))]"
      text={t('editor.sfdAbout')}
    >
      <button
        type="button"
        aria-label={t('editor.sfdInfo')}
        // In the section title, so a click must not open or close the section.
        onClick={(event) => event.preventDefault()}
        className="cursor-default rounded text-tone-500 hover:text-tone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Tooltip>
  )
}

/**
 * The SFD RAW section of an X3I: a toggle between the SFD RAW, the merge of all
 * frames, and the unfused RAW, its middle exposure. Turning it on, or the fuse
 * button, merges the frames once, while the unfused RAW stays editable. A
 * merge shows a cancel button. The stored SFD RAW shows as the fused SFD RAW,
 * with its size and a delete button.
 */
export function SfdRaw({ recipe }: { recipe: EditRecipe }): React.JSX.Element | null {
  const x3i = useEditorStore((state) => state.x3i)
  const path = useEditorStore((state) => state.session?.path)
  const file = useQueueStore((state) => state.files.find((entry) => entry.path === path))
  const pending = useEditorStore(needsX3iMerge)
  const processX3i = useEditorStore((state) => state.processX3i)
  const cancelX3i = useEditorStore((state) => state.cancelX3i)
  const deleteX3i = useEditorStore((state) => state.deleteX3i)
  const change = useEditorStore((state) => state.change)
  const switching = useEditorStore((state) => state.switching)
  const busy = useBusy()
  const running = x3i?.progress !== undefined
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void useEditorStore.getState().refreshX3i(true), POLL)
    return () => clearInterval(timer)
  }, [running])
  // A photo that uses an SFD RAW that is not stored, as after an undo of a delete, merges it.
  const failed = !!x3i?.error
  useEffect(() => {
    if (pending && !running && !failed && !busy) processX3i()
  }, [pending, running, failed, busy, path, processX3i])
  if (!x3i) return null
  const sfd = usesSfd(recipe)
  const percent = Math.round((x3i.progress ?? 0) * 100)
  const toggle = (on: boolean): void => {
    if (on) {
      if (x3i.processed) change({ x3iSource: 'merge' })
      else processX3i()
      return
    }
    // The unfused RAW is absent from a recipe, as in recipes from the backend.
    if (sfd) change({ x3iSource: undefined })
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 rounded-lg border border-ink/10 bg-ink/[0.03] py-0.5 pl-0.5 pr-1.5">
        {/* Gray is the unfused RAW, color the SFD RAW. A merge fills it. Each photo starts at its state. */}
        <span
          className="shrink-0"
          {...(running && {
            role: 'progressbar',
            'aria-label': t('editor.x3iMerging'),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': percent
          })}
        >
          <SfdCube
            key={path}
            fill={running ? (x3i.progress ?? 0) : sfd && x3i.processed ? 1 : 0}
            fusing={running}
            file={file}
          />
        </span>
        <div className="min-w-0 flex-1">
          {running ? (
            <>
              <p className="text-shimmer truncate text-xs">{t('editor.x3iMerging')}</p>
              <p aria-hidden="true" className="text-[11px] tabular-nums text-tone-500">
                {percent}%
              </p>
            </>
          ) : x3i.processed ? (
            <>
              {/* The cache file name shows on hover. */}
              <p className="truncate text-xs text-tone-200" title={x3i.name}>
                {t('editor.sfdFused')}
              </p>
              {x3i.bytes !== undefined && (
                <p className="text-[11px] text-tone-500">{formatBytes(x3i.bytes)}</p>
              )}
            </>
          ) : (
            <p className="truncate text-xs text-tone-200">{t('editor.x3iSourceMiddle')}</p>
          )}
        </div>
        {running ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={t('button.cancel')}
            title={t('button.cancel')}
            onClick={cancelX3i}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : !x3i.processed ? (
          <Button
            variant="bordered"
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={processX3i}
          >
            {t('editor.sfdFuse')}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={t('editor.sfdDelete')}
            title={t('editor.sfdDelete')}
            disabled={busy}
            onClick={deleteX3i}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
      <ToggleRow
        label={t('editor.sfdUse')}
        checked={sfd || running}
        onChange={toggle}
        // A merge or a change between the two RAWs finishes first.
        disabled={busy || running || switching}
      />
      {x3i.error && (
        <p role="alert" className="text-xs text-danger">
          {x3i.error}
        </p>
      )}
    </div>
  )
}
