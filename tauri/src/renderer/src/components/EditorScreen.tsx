import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Copy,
  ClipboardPaste,
  Undo2,
  Redo2,
  RotateCcw,
  Loader2,
  Crop
} from 'lucide-react'
import { useEditorStore, isTextEditing } from '../stores/editorStore'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { ResizablePanel } from './ui/resizablePanel'
import { ZoomControls } from './ZoomControls'
import { ZoomablePreview } from './ZoomablePreview'
import { FileFilmstrip } from './FileFilmstrip'
import { ColorScope } from './ColorScope'
import { ScopeMenu } from './ScopeMenu'
import { BatchProgress } from './BatchProgress'
import { EditorControls } from './EditorControls'
import { CropPreview } from './CropPreview'
import { OrientedImage } from './OrientedImage'

export function EditorScreen(): React.JSX.Element {
  const editor = useEditorStore()
  const files = useQueueStore((state) => state.files)
  const activeId = useQueueStore((state) => state.activeId)
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const scope = useSettingsStore((state) => state.settings.inspectorScopeMode)
  const [picking, setPicking] = useState(false)
  const active = files.find((file) => file.id === activeId)
  const file = files.find((file) => file.path === editor.session?.path)
  const currentFile = active ?? file
  const doc = editor.session ? editor.documents[editor.session.path] : undefined

  const requestedPath = useRef<string>()
  useEffect(() => {
    if (
      active &&
      !active.pending &&
      !busy &&
      !editor.loading &&
      requestedPath.current !== active.path &&
      active.path !== editor.session?.path
    ) {
      requestedPath.current = active.path
      void editor.open(active)
    }
  }, [active, busy, editor])
  useEffect(() => {
    setPicking(false)
  }, [editor.session?.sessionId])
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (isTextEditing(event.target) || event.defaultPrevented) return
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (!busy) {
          if (event.shiftKey) editor.redo()
          else editor.undo()
        }
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        editor.copy()
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        if (!busy) void editor.paste()
      } else if (!modifier && event.key === '\\') {
        event.preventDefault()
        if (!event.repeat) editor.compare(!editor.before)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        if (picking) setPicking(false)
        else if (!busy) void editor.close()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [editor, busy, picking])
  const displayFile = useMemo(
    () =>
      file &&
      file.path === currentFile?.path &&
      editor.preview?.sessionId === editor.session?.sessionId &&
      editor.preview
        ? {
            ...file,
            displayPreviewUrl: editor.preview.url,
            orientation: 1,
            aspectRatio: undefined
          }
        : undefined,
    [file, currentFile?.path, editor.preview, editor.session?.sessionId]
  )
  const placeholderDoc = currentFile && editor.documents[currentFile.path]
  const placeholderFile =
    !displayFile &&
    currentFile &&
    !currentFile.pending &&
    (!currentFile.edit || currentFile.edit.previewUrl) &&
    (!placeholderDoc ||
      (!placeholderDoc.dirty &&
        !placeholderDoc.gesture &&
        (currentFile.edit
          ? currentFile.edit.revision === placeholderDoc.revision &&
            currentFile.edit.sourceRevision === placeholderDoc.sourceRevision &&
            JSON.stringify(currentFile.edit.recipe) === JSON.stringify(placeholderDoc.recipe)
          : placeholderDoc.storage === 'none')))
      ? currentFile
      : undefined
  const unavailable = !doc || !displayFile || editor.loading || busy
  const naturalSize = useMemo(
    () =>
      editor.preview?.fullWidth && editor.preview.fullHeight
        ? { width: editor.preview.fullWidth, height: editor.preview.fullHeight }
        : undefined,
    [editor.preview?.fullWidth, editor.preview?.fullHeight]
  )
  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950">
      <div
        data-tauri-drag-region
        className="window-toolbar flex h-12 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void editor.close()}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('editor.done')}
          </Button>
          <span
            className="max-w-40 truncate text-xs text-neutral-400"
            title={currentFile?.fileName}
          >
            {currentFile?.fileName}
          </span>
          <ZoomControls />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <BatchProgress />
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('editor.undo')}
            title={t('editor.undo')}
            disabled={unavailable || !doc?.past.length}
            onClick={editor.undo}
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('editor.redo')}
            title={t('editor.redo')}
            disabled={unavailable || !doc?.future.length}
            onClick={editor.redo}
          >
            <Redo2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={editor.before}
            disabled={unavailable}
            onClick={() => editor.compare(!editor.before)}
          >
            {t(editor.before ? 'editor.before' : 'editor.after')}
          </Button>
          <Button
            variant="prominent"
            size="sm"
            disabled={unavailable || !file}
            onClick={() =>
              file && useQueueStore.getState().openExport(new Set([file.id]), 'editor')
            }
          >
            {t('button.convert')}
          </Button>
        </div>
      </div>
      {editor.error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-red-500/20 bg-red-950/30 px-4 py-2 text-xs text-red-300"
        >
          <span>{editor.error}</span>
          <Button
            size="sm"
            variant="bordered"
            onClick={() => {
              if (editor.session) {
                void editor.flush()
                editor.render()
              } else if (active) void editor.open(active)
            }}
          >
            {t('editor.retry')}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <FileFilmstrip
          preview={
            <div className="relative h-full w-full">
              {displayFile && editor.preview && doc && editor.cropping && !unavailable ? (
                <CropPreview preview={editor.preview} recipe={doc.recipe} />
              ) : displayFile ? (
                <ZoomablePreview
                  key={file?.id}
                  file={displayFile}
                  naturalSize={naturalSize}
                  tile={editor.tile}
                  onViewportChange={editor.setViewport}
                  onImagePoint={
                    picking && !unavailable
                      ? (x, y) => {
                          setPicking(false)
                          void editor.pickWhiteBalance(x, y)
                        }
                      : undefined
                  }
                />
              ) : placeholderFile ? (
                <OrientedImage
                  file={placeholderFile}
                  loading="eager"
                  containerClassName="h-full w-full"
                  className="h-auto w-auto object-contain"
                />
              ) : (
                <div
                  role="status"
                  className="flex h-full items-center justify-center gap-2 text-xs text-neutral-500"
                >
                  {editor.loading || editor.rendering ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      {t('editor.developing')}
                    </>
                  ) : (
                    t('inspector.no_preview')
                  )}
                </div>
              )}
              {(displayFile || placeholderFile) &&
                (editor.loading ||
                  editor.rendering ||
                  (!editor.error &&
                    (editor.viewport ? editor.tile?.draft : editor.preview?.draft))) && (
                  <span
                    role="status"
                    className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/60 px-2 py-1 text-xs text-neutral-300"
                  >
                    {t('editor.developing')}
                  </span>
                )}
              {displayFile && editor.before && (
                <span className="pointer-events-none absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs">
                  {t('editor.before')}
                </span>
              )}
            </div>
          }
        />
        <ResizablePanel kind="editor">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-white/10 px-3 text-xs text-neutral-400">
            <span>{t('editor.adjustments')}</span>
            <ScopeMenu />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="p-3">
              {editor.viewport && (
                <p className="mb-1 text-[11px] text-neutral-500">{t('editor.visibleArea')}</p>
              )}
              <ColorScope
                url={
                  displayFile
                    ? editor.viewport
                      ? editor.tile?.url
                      : editor.preview?.url
                    : undefined
                }
                fileId={currentFile?.id}
                pending={editor.loading || (!!editor.viewport && !editor.tile && editor.rendering)}
                mode={scope}
              />
            </div>
            <div className="flex flex-wrap gap-1 border-y border-white/10 px-2 py-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={unavailable}
                aria-pressed={editor.cropping}
                onClick={() => {
                  setPicking(false)
                  editor.setCropping(!editor.cropping)
                }}
              >
                <Crop className="h-3.5 w-3.5" aria-hidden="true" />
                {t(editor.cropping ? 'editor.applyCrop' : 'editor.crop')}
              </Button>
              <Button variant="ghost" size="sm" disabled={unavailable} onClick={editor.copy}>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                {t('editor.copy')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={unavailable || !editor.clipboard}
                onClick={() => void editor.paste()}
              >
                <ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" />
                {t('editor.paste')}
              </Button>
              <Button variant="ghost" size="sm" disabled={unavailable} onClick={editor.reset}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {t('editor.reset')}
              </Button>
            </div>
            {doc && (
              <>
                <p
                  role="status"
                  className="px-3 py-2 text-[11px] text-neutral-500"
                  title={doc.storagePath}
                >
                  {t(
                    doc.dirty
                      ? 'editor.saving'
                      : doc.storage === 'backup'
                        ? 'editor.savedBackup'
                        : doc.storage === 'none'
                          ? 'editor.original'
                          : 'editor.saved'
                  )}
                </p>
                <fieldset disabled={unavailable || editor.before} className="contents">
                  <EditorControls
                    recipe={doc.recipe}
                    picking={picking}
                    setPicking={(value) => {
                      if (value && editor.cropping) editor.setCropping(false)
                      setPicking(value)
                    }}
                  />
                </fieldset>
              </>
            )}
          </div>
        </ResizablePanel>
      </div>
    </div>
  )
}
