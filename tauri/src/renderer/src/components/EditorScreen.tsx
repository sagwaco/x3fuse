import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Copy,
  ClipboardPaste,
  Undo2,
  Redo2,
  RotateCcw,
  Loader2,
  Crop,
  RotateCcwSquare,
  RotateCwSquare,
  SquareSplitHorizontal,
  ArrowLeft
} from 'lucide-react'
import type { EditRecipe } from '@shared/editor'
import { useEditorStore, isTextEditing } from '../stores/editorStore'
import { useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { ResizablePanel } from './ui/resizablePanel'
import { useToolbarSwap } from '../hooks/useToolbarSwap'
import { ZoomControls } from './ZoomControls'
import { ZoomablePreview } from './ZoomablePreview'
import { FileFilmstrip } from './FileFilmstrip'
import { ColorScope } from './ColorScope'
import { ScopeMenu } from './ScopeMenu'
import { BatchProgress } from './BatchProgress'
import { EditorControls, FilmControls } from './EditorControls'
import { LookPicker } from './LookPicker'
import { CropControls } from './CropControls'
import { CropPreview } from './CropPreview'
import { FULL, matchAspect } from '../lib/cropGeometry'
import { DevelopingPreview } from './DevelopingPreview'
import { DevelopingCloud } from '../lib/developingCloud'

type SidebarPage = 'edit' | 'film' | 'paper' | 'darkroom'

export function EditorScreen(): React.JSX.Element {
  const editor = useEditorStore()
  const files = useQueueStore((state) => state.files)
  const activeId = useQueueStore((state) => state.activeId)
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const scope = useSettingsStore((state) => state.settings.inspectorScopeMode)
  const [picking, setPicking] = useState(false)
  const [sidebarPage, setSidebarPage] = useState<SidebarPage>('edit')
  const sidebarBody = useRef<HTMLDivElement>(null)
  const sidebarBack = useRef<HTMLButtonElement>(null)
  const sidebarOrigin = useRef<SidebarPage>('edit')
  const sidebarScroll = useRef(0)
  const navigateSidebar = useCallback((page: SidebarPage): void => {
    setPicking(false)
    if (page !== 'edit') {
      if (sidebarOrigin.current === 'edit')
        sidebarScroll.current = sidebarBody.current?.scrollTop ?? 0
      sidebarOrigin.current = page === 'paper' ? 'darkroom' : page
    }
    setSidebarPage(page)
  }, [])
  useLayoutEffect(() => {
    const body = sidebarBody.current
    if (!body) return
    body.scrollTop = sidebarPage === 'edit' ? sidebarScroll.current : 0
    if (sidebarPage !== 'edit') sidebarBack.current?.focus()
    else if (sidebarOrigin.current !== 'edit') {
      const origin =
        body.querySelector<HTMLElement>(`[data-sidebar-page="${sidebarOrigin.current}"]`) ??
        body.querySelector<HTMLElement>('[data-sidebar-page="film"]')
      origin?.focus({ preventScroll: true })
      sidebarOrigin.current = 'edit'
    } else return
    if (!body.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const animation = body.animate(
      [
        { opacity: 0, transform: `translateX(${sidebarPage === 'edit' ? -20 : 20}px)` },
        { opacity: 1, transform: 'translateX(0)' }
      ],
      { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    )
    return () => animation.cancel()
  }, [sidebarPage])
  // The aspect option is fixed on entering crop mode so resizing keeps its shape.
  const [aspect, setAspect] = useState('free')
  const active = files.find((file) => file.id === activeId)
  const file = files.find((file) => file.path === editor.session?.path)
  const currentFile = active ?? file
  const doc = editor.session ? editor.documents[editor.session.path] : undefined
  useEffect(() => {
    if (!doc?.recipe.film && (sidebarPage === 'darkroom' || sidebarPage === 'paper'))
      navigateSidebar('edit')
  }, [doc?.recipe.film, sidebarPage, navigateSidebar])
  // The photo's geometry when crop mode opened; Cancel puts it back.
  const entry = useRef<{ path: string; geometry: Partial<EditRecipe> }>()
  const cropButton = useRef<HTMLButtonElement>(null)
  const enterCrop = (): void => {
    setPicking(false)
    editor.compare(false)
    const width = editor.preview?.sourceWidth
    const height = editor.preview?.sourceHeight
    if (doc && width && height)
      setAspect(
        matchAspect(
          doc.recipe.crop ?? FULL,
          editor.session?.asShotCrop ?? FULL,
          doc.recipe.rotation,
          width,
          height
        )
      )
    if (editor.session && doc) {
      const { crop, rotation, straighten, pitch, yaw } = doc.recipe
      entry.current = {
        path: editor.session.path,
        geometry: { crop, rotation, straighten, pitch, yaw }
      }
    }
    editor.setCropping(true)
  }
  const { change, setCropping } = editor
  // Leaving the editor screen (Export, the library) applies the crop, so crop
  // mode never outlives the Cancel snapshot kept here.
  useEffect(
    () => () => {
      const state = useEditorStore.getState()
      if (state.cropping) state.setCropping(false)
    },
    []
  )
  const cancelCrop = useCallback((): void => {
    const saved = entry.current
    // Only restore onto the photo the snapshot came from, and only if it changed.
    if (saved && doc && saved.path === editor.session?.path) {
      const changed = (Object.keys(saved.geometry) as Array<keyof EditRecipe>).some(
        (key) => JSON.stringify(saved.geometry[key]) !== JSON.stringify(doc.recipe[key])
      )
      if (changed) change(saved.geometry)
    }
    entry.current = undefined
    setCropping(false)
  }, [doc, editor.session?.path, change, setCropping])

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
    sidebarOrigin.current = 'edit'
    sidebarScroll.current = 0
    setSidebarPage('edit')
  }, [editor.session?.sessionId])
  useEffect(() => {
    if (editor.cropping) navigateSidebar('edit')
  }, [editor.cropping, navigateSidebar])
  useEffect(() => {
    if (sidebarPage === 'edit') return
    const back = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) navigateSidebar('edit')
    }
    window.addEventListener('keydown', back, true)
    return () => window.removeEventListener('keydown', back, true)
  }, [sidebarPage, navigateSidebar])
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
      } else if (event.key === 'Escape') {
        event.preventDefault()
        // Holding Escape must not cancel crop mode and then close the editor.
        if (event.repeat) return
        if (picking) setPicking(false)
        else if (editor.cropping) cancelCrop()
        else if (!busy) void editor.close()
      } else if (editor.cropping) {
        // Crop mode hides copy, paste and compare; their shortcuts wait too.
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        editor.copy()
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        if (!busy) void editor.paste()
      } else if (!modifier && event.key === '\\') {
        event.preventDefault()
        if (!event.repeat) editor.compare(!editor.before)
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [editor, busy, picking, cancelCrop])
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
  // The photo's saved previews show its current edit.
  const savedMatches =
    !!currentFile &&
    (!currentFile.edit || !!currentFile.edit.previewUrl) &&
    (!placeholderDoc ||
      (!placeholderDoc.dirty &&
        !placeholderDoc.gesture &&
        (currentFile.edit
          ? currentFile.edit.revision === placeholderDoc.revision &&
            currentFile.edit.sourceRevision === placeholderDoc.sourceRevision &&
            JSON.stringify(currentFile.edit.recipe) === JSON.stringify(placeholderDoc.recipe)
          : placeholderDoc.storage === 'none')))
  const loadingFile = !displayFile && currentFile && !currentFile.pending ? currentFile : undefined
  // The placeholder stays over the first preview while its cloud condenses.
  const [condensing, setCondensing] = useState<typeof loadingFile>()
  const cloudFile =
    loadingFile ?? (displayFile && condensing?.path === displayFile.path ? condensing : undefined)
  if (cloudFile !== condensing) setCondensing(cloudFile)
  // It condenses once the preview paints, or after a second if that preview cannot paint.
  // Each cleared preview, such as a crop mode change, waits for a new paint.
  const [painted, setPainted] = useState(false)
  const previewShown = !!displayFile
  if (!previewShown && painted) setPainted(false)
  useEffect(() => {
    if (!previewShown) return
    const timer = setTimeout(() => setPainted(true), 1000)
    return () => clearTimeout(timer)
  }, [previewShown])
  const unavailable = !doc || !displayFile || editor.loading || busy
  // The toolbar lags behind crop mode while its buttons animate out and in.
  const swap = useToolbarSwap(editor.cropping)
  const inert = swap.leaving ? { inert: '' } : {}
  // Give focus back to the Crop button when crop mode ends. The button stays
  // disabled until the next preview arrives, so wait for it, and only take focus
  // that nothing else has.
  const wasCropping = useRef(editor.cropping)
  const refocus = useRef(false)
  useEffect(() => {
    if (wasCropping.current && !editor.cropping) refocus.current = true
    if (editor.cropping) refocus.current = false
    wasCropping.current = editor.cropping
    const free = !document.activeElement || document.activeElement === document.body
    if (refocus.current && !unavailable && cropButton.current && free) {
      cropButton.current.focus({ preventScroll: true })
      refocus.current = false
    }
  }, [editor.cropping, unavailable, swap.shown])
  const naturalSize = useMemo(
    () =>
      editor.preview?.fullWidth && editor.preview.fullHeight
        ? { width: editor.preview.fullWidth, height: editor.preview.fullHeight }
        : undefined,
    [editor.preview?.fullWidth, editor.preview?.fullHeight]
  )
  const history = (
    <>
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
    </>
  )
  const content = (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950">
      <div
        ref={swap.ref}
        data-tauri-drag-region
        className="window-toolbar flex h-12 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="max-w-40 truncate text-xs text-neutral-400"
            title={currentFile?.fileName}
          >
            {currentFile?.fileName}
          </span>
          {!swap.shown && (
            <div data-swap className="contents" {...inert}>
              <ZoomControls />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <BatchProgress />
          {/* Keyed so the two toolbars never share (and pass focus through) buttons. */}
          {swap.shown ? (
            <div key="crop" data-swap className="contents" {...inert}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('editor.rotateLeft')}
                title={t('editor.rotateLeft')}
                disabled={unavailable || !doc}
                onClick={() => doc && change({ rotation: (doc.recipe.rotation + 3) % 4 })}
              >
                <RotateCcwSquare className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('editor.rotate')}
                title={t('editor.rotate')}
                disabled={unavailable || !doc}
                onClick={() => doc && change({ rotation: (doc.recipe.rotation + 1) % 4 })}
              >
                <RotateCwSquare className="h-4 w-4" />
              </Button>
              <div
                role="separator"
                aria-orientation="vertical"
                className="mx-1 h-5 w-px bg-white/15"
              />
              {history}
              <div
                role="separator"
                aria-orientation="vertical"
                className="mx-1 h-5 w-px bg-white/15"
              />
              <Button variant="bordered" size="sm" disabled={unavailable} onClick={cancelCrop}>
                {t('button.cancel')}
              </Button>
              <Button
                variant="prominent"
                size="sm"
                disabled={unavailable}
                onClick={() => setCropping(false)}
              >
                {t('editor.applyCrop')}
              </Button>
            </div>
          ) : (
            <div key="edit" data-swap className="contents" {...inert}>
              <Button
                ref={cropButton}
                variant="ghost"
                size="icon"
                aria-label={t('editor.crop')}
                title={t('editor.crop')}
                disabled={unavailable}
                onClick={enterCrop}
              >
                <Crop className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('editor.copy')}
                title={t('editor.copy')}
                disabled={unavailable}
                onClick={editor.copy}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('editor.paste')}
                title={t('editor.paste')}
                disabled={unavailable || !editor.clipboard}
                onClick={() => void editor.paste()}
              >
                <ClipboardPaste className="h-4 w-4" />
              </Button>
              <div
                role="separator"
                aria-orientation="vertical"
                className="mx-1 h-5 w-px bg-white/15"
              />
              {history}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('editor.compare')}
                title={t('editor.compare')}
                aria-pressed={editor.before}
                disabled={unavailable}
                onClick={() => editor.compare(!editor.before)}
              >
                <SquareSplitHorizontal className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void editor.close()}>
                {t('editor.done')}
              </Button>
              <div
                role="separator"
                aria-orientation="vertical"
                className="mx-1 h-5 w-px bg-white/15"
              />
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
          )}
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
                <CropPreview
                  preview={editor.preview}
                  recipe={doc.recipe}
                  locked={aspect !== 'free'}
                  onDone={() => setCropping(false)}
                  onPaint={() => setPainted(true)}
                />
              ) : displayFile ? (
                <ZoomablePreview
                  key={file?.id}
                  file={displayFile}
                  naturalSize={naturalSize}
                  tile={editor.tile}
                  cache={editor.cache}
                  onCacheMiss={editor.uncache}
                  onViewportChange={editor.setViewport}
                  onViewportMove={editor.holdPrefetch}
                  onPaint={() => setPainted(true)}
                  onImagePoint={
                    picking && !unavailable
                      ? (x, y) => {
                          setPicking(false)
                          void editor.pickWhiteBalance(x, y)
                        }
                      : undefined
                  }
                />
              ) : cloudFile ? null : (
                <div
                  role="status"
                  className="flex h-full items-center justify-center gap-2 text-xs text-neutral-500"
                >
                  {editor.loading || editor.rendering ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      <span className="sr-only">{t('editor.developing')}</span>
                    </>
                  ) : (
                    t('inspector.no_preview')
                  )}
                </div>
              )}
              {cloudFile && (
                <DevelopingPreview
                  key={`developing:${cloudFile.id}:${savedMatches && !editor.cropping}`}
                  file={cloudFile}
                  matching={savedMatches && !editor.cropping}
                  developing={editor.loading || editor.rendering}
                  ready={previewShown && painted}
                  onDone={() => setCondensing(undefined)}
                />
              )}
              <span role="status" className="sr-only">
                {loadingFile && (editor.loading || editor.rendering) ? t('editor.developing') : ''}
              </span>
              {displayFile && editor.before && (
                <span className="glass-overlay pointer-events-none absolute left-3 top-3 rounded-full px-3 py-1 text-xs text-white">
                  {t('editor.before')}
                </span>
              )}
            </div>
          }
        />
        <ResizablePanel kind="editor">
          <div className="z-10 flex h-8 shrink-0 items-center justify-between border-b border-white/10 px-3 text-xs text-neutral-400">
            {sidebarPage === 'edit' ? (
              <>
                <span className="font-bold">{t('editor.adjustments')}</span>
                <ScopeMenu />
              </>
            ) : (
              <>
                <Button
                  ref={sidebarBack}
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label={t('editor.backToAdjustments')}
                  title={t('editor.backToAdjustments')}
                  onClick={() => navigateSidebar('edit')}
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </Button>
                <h2 className="font-bold">
                  {t(
                    sidebarPage === 'film'
                      ? 'editor.filmStock'
                      : sidebarPage === 'paper'
                        ? 'editor.paperStock'
                        : 'editor.darkroom'
                  )}
                </h2>
                <span className="w-6" />
              </>
            )}
          </div>
          <div ref={sidebarBody} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-3">
            {sidebarPage !== 'edit' && doc && (
              <fieldset disabled={unavailable || editor.before || !!cloudFile} className="contents">
                {sidebarPage === 'darkroom' ? (
                  doc.recipe.film && (
                    <FilmControls
                      recipe={doc.recipe}
                      film={doc.recipe.film}
                      darkroom
                      onNavigate={navigateSidebar}
                    />
                  )
                ) : (
                  <LookPicker kind={sidebarPage} recipe={doc.recipe} gallery />
                )}
              </fieldset>
            )}
            <div hidden={sidebarPage !== 'edit'}>
              <div className="p-3">
                {editor.viewport && (
                  <p className="control-label mb-1 text-[10px] text-neutral-500">
                    {t('editor.visibleArea')}
                  </p>
                )}
                <ColorScope
                  // The scope reads its pixels after the developing cloud leaves.
                  // The read would make the cloud skip frames.
                  url={
                    displayFile && !cloudFile && sidebarPage === 'edit'
                      ? editor.viewport
                        ? editor.tile?.url
                        : editor.preview?.url
                      : undefined
                  }
                  fileId={currentFile?.id}
                  pending={
                    !!cloudFile ||
                    editor.loading ||
                    (!!editor.viewport && !editor.tile && editor.rendering)
                  }
                  mode={scope}
                />
              </div>
              {doc && (
                <>
                  <div className="flex items-center justify-between gap-2 px-4 py-1.5">
                    <p
                      role="status"
                      className="control-label text-[10px] text-neutral-500"
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
                    {/* Resets every adjustment; crop mode's Cancel could not undo it. */}
                    {!editor.cropping && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[10px] text-neutral-500"
                        disabled={unavailable}
                        onClick={editor.reset}
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('editor.reset')}
                      </Button>
                    )}
                  </div>
                  <fieldset
                    disabled={unavailable || editor.before || !!cloudFile}
                    className="contents"
                  >
                    {editor.cropping ? (
                      <CropControls recipe={doc.recipe} aspect={aspect} setAspect={setAspect} />
                    ) : (
                      <EditorControls
                        recipe={doc.recipe}
                        picking={picking}
                        setPicking={setPicking}
                        onNavigate={navigateSidebar}
                      />
                    )}
                  </fieldset>
                </>
              )}
            </div>
          </div>
        </ResizablePanel>
      </div>
    </div>
  )
  return <DevelopingCloud.Provider value={!!cloudFile}>{content}</DevelopingCloud.Provider>
}
