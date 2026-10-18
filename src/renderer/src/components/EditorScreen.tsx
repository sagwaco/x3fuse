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
  ArrowLeft,
  PanelRight,
  Pipette
} from 'lucide-react'
import { negativePrint, type EditRecipe, type PreviewRegion } from '@shared/editor'
import {
  useEditorStore,
  isTextEditing,
  needsX3iMerge,
  previewCurrent,
  geometryKey
} from '../stores/editorStore'
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
import { EditorControls, EmulsionControls } from './EditorControls'
import { LookPicker } from './LookPicker'
import { PhotoInfo } from './PhotoInfo'
import { CropControls } from './CropControls'
import { CropPreview } from './CropPreview'
import { FULL, matchAspect } from '../lib/cropGeometry'
import { DevelopingPreview } from './DevelopingPreview'
import { DevelopingCloud } from '../lib/developingCloud'
import { CullError, ExportButton, FilterButton } from './Toolbar'
import { FilterBar } from './FilterBar'
import { cn } from '../lib/cn'
import { withShortcut } from '../lib/shortcut'

type SidebarPage = 'edit' | 'emulsion' | 'paper'
/** The pixels that the scope measures. */
const SCOPE_SOURCES = [
  ['entire', 'scopeEntire'],
  ['visible', 'scopeVisible'],
  ['qualifier', 'scopeQualifier']
] as const
type ScopeSource = (typeof SCOPE_SOURCES)[number][0]

export function EditorScreen(): React.JSX.Element {
  const editor = useEditorStore()
  const files = useQueueStore((state) => state.files)
  const activeId = useQueueStore((state) => state.activeId)
  const busy = useQueueStore((state) => state.isProcessing || state.isPreparing)
  const scope = useSettingsStore((state) => state.settings.inspectorScopeMode)
  const panelOpen = useSettingsStore((state) => state.settings.editorPanelOpen)
  const filterOpen = useQueueStore((state) => state.filterOpen)
  const [picking, setPicking] = useState(false)
  // W arms the picker only while its controls are enabled. It can always turn it off.
  const canPick = useRef(false)
  const [scopeSource, setScopeSource] = useState<ScopeSource>('entire')
  // While armed, a click or a drag on the photo sets the area that the Qualifier measures.
  const [qualifying, setQualifying] = useState(false)
  const [qualified, setQualified] = useState<{ key: string; region: PreviewRegion } | null>(null)
  // The white balance picker and the Qualifier use the same clicks, so one disarms the other.
  if (picking && qualifying) setQualifying(false)
  // Choosing the Qualifier arms it again, so a new area can replace the last one.
  const chooseScope = (next: ScopeSource): void => {
    if (next === 'qualifier') setPicking(false)
    else setQualified(null)
    setQualifying(next === 'qualifier')
    setScopeSource(next)
  }
  const [sidebarPage, setSidebarPage] = useState<SidebarPage>('edit')
  const sidebarBody = useRef<HTMLDivElement>(null)
  const sidebarBack = useRef<HTMLButtonElement>(null)
  const previousSidebar = useRef<SidebarPage>('edit')
  const sidebarScroll = useRef<Record<SidebarPage, number>>({ edit: 0, emulsion: 0, paper: 0 })
  const navigateSidebar = useCallback(
    (page: SidebarPage): void => {
      setPicking(false)
      setQualifying(false)
      sidebarScroll.current[sidebarPage] = sidebarBody.current?.scrollTop ?? 0
      setSidebarPage(page)
    },
    [sidebarPage]
  )
  useLayoutEffect(() => {
    const body = sidebarBody.current
    const previous = previousSidebar.current
    previousSidebar.current = sidebarPage
    if (!body || previous === sidebarPage) return
    const returning = sidebarPage === 'edit' || previous === 'paper'
    body.scrollTop = returning ? sidebarScroll.current[sidebarPage] : 0
    if (returning) {
      const origin = body.querySelector<HTMLElement>(`[data-sidebar-page="${previous}"]`)
      const fallback = body.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      const focus = origin ?? fallback ?? sidebarBack.current
      focus?.focus({ preventScroll: true })
    } else sidebarBack.current?.focus()
    if (!body.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const animation = body.animate(
      [
        { opacity: 0, transform: `translateX(${returning ? -20 : 20}px)` },
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
  // A qualified area belongs to one photo and its geometry. A change clears it.
  const geometry = doc && geometryKey(doc.recipe)
  const areaKey = `${editor.session?.sessionId}:${geometry}`
  if (qualified && qualified.key !== areaKey) setQualified(null)
  // The photo and the geometry of the frame on screen. A new preview shows only after it
  // decodes, so until then the previous frame, of other geometry, can stay on screen.
  const [shownArea, setShownArea] = useState<string | null>(null)
  const qualify = (region: PreviewRegion): void => {
    // A frame of other geometry, as before an undone rotation paints, shows other pixels.
    // The latest render must match too: a point gets its square from that render's size,
    // which can differ after an undo and a redo before either frame paints.
    if (shownArea !== areaKey || editor.previewGeometry !== geometry) return
    setQualified({ key: areaKey, region })
    setQualifying(false)
  }
  // An X3I whose SFD RAW is not stored yet merges it, and only its SFD RAW section works.
  const x3iPending = needsX3iMerge(editor)
  useEffect(() => {
    if (!doc?.recipe.film && sidebarPage === 'paper') navigateSidebar('edit')
  }, [doc?.recipe.film, sidebarPage, navigateSidebar])
  // The photo's geometry when crop mode opened; Cancel puts it back.
  const entry = useRef<{ path: string; geometry: Partial<EditRecipe> }>()
  const cropButton = useRef<HTMLButtonElement>(null)
  const enterCrop = (): void => {
    setPicking(false)
    setQualifying(false)
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
    setQualifying(false)
    previousSidebar.current = 'edit'
    sidebarScroll.current = { edit: 0, emulsion: 0, paper: 0 }
    if (sidebarBody.current) sidebarBody.current.scrollTop = 0
    setSidebarPage('edit')
  }, [editor.session?.sessionId])
  useEffect(() => {
    if (editor.cropping || x3iPending) navigateSidebar('edit')
    // The SFD RAW section shows near the top of the panel.
    if (x3iPending) {
      sidebarScroll.current.edit = 0
      if (sidebarBody.current) sidebarBody.current.scrollTop = 0
    }
  }, [editor.cropping, x3iPending, navigateSidebar])
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
        else if (qualifying) setQualifying(false)
        else if (editor.cropping) cancelCrop()
        else if (!busy) void editor.close()
      } else if (editor.cropping) {
        // Crop mode hides copy, paste and compare; their shortcuts wait too.
      } else if (modifier && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        editor.copy()
      } else if (modifier && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        if (!busy) void editor.paste()
      } else if (!modifier && event.key === '\\') {
        event.preventDefault()
        if (!event.repeat) editor.compare(!editor.before)
      } else if (
        !modifier &&
        event.key.toLowerCase() === 'w' &&
        !document.querySelector('[role="dialog"][data-state="open"]')
      ) {
        event.preventDefault()
        if (!event.repeat && (picking || canPick.current)) setPicking(!picking)
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [editor, busy, picking, qualifying, cancelCrop])
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
  // An X3I that waits for its merge has no render. Its embedded preview can still zoom and pan.
  const previewFile =
    displayFile ?? (x3iPending && file?.path === currentFile?.path ? file : undefined)
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
  const loadingFile = !previewFile && currentFile && !currentFile.pending ? currentFile : undefined
  // The placeholder stays over the first preview while its cloud condenses.
  const [condensing, setCondensing] = useState<typeof loadingFile>()
  const cloudFile =
    loadingFile ?? (displayFile && condensing?.path === displayFile.path ? condensing : undefined)
  if (cloudFile !== condensing) setCondensing(cloudFile)
  // It condenses once the preview paints, or after a second if that preview cannot paint.
  // Each cleared preview, such as a crop mode change, waits for a new paint.
  const [painted, setPainted] = useState(false)
  const previewShown = !!displayFile
  // A change between the SFD RAW and the unfused RAW of an X3I turns the preview
  // into particles until the photo renders again.
  const [morph, setMorph] = useState<string>()
  // While zoomed, the tile of the current view shows what is on screen.
  const viewTile =
    editor.viewport &&
    editor.tile &&
    JSON.stringify(editor.tile.viewport) === JSON.stringify(editor.viewport)
  if (editor.switching && !morph && displayFile)
    setMorph(viewTile ? editor.tile!.url : displayFile.displayPreviewUrl)
  if (morph && !displayFile) setMorph(undefined)
  if (!previewShown && painted) setPainted(false)
  useEffect(() => {
    if (!previewShown) return
    const timer = setTimeout(() => setPainted(true), 1000)
    return () => clearTimeout(timer)
  }, [previewShown])
  const unavailable = !doc || !displayFile || editor.loading || busy
  canPick.current = !unavailable && !editor.before && !cloudFile
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
  // A negative print can show as a positive. Before shows the original, so it stays as it is.
  const inverted =
    editor.negativePreview && !editor.before && !!doc && negativePrint(doc.recipe.film)
  // While zoomed, an edit renders the tile first, and the whole-image preview later.
  // Visible area reads the tile of the current view; the other sources read the
  // preview of the current recipe. Until it arrives, the scope keeps its last paint as pending.
  const sourceUrl =
    scopeSource === 'visible' && editor.viewport
      ? viewTile
        ? editor.tile?.url
        : undefined
      : !editor.viewport || previewCurrent(editor)
        ? editor.preview?.url
        : undefined
  // The preview gives points and rectangles as 0 to 1 of the image that it shows: the
  // rendered preview, cropped and oriented. The scope reads the same preview, so they
  // need no conversion. Crop mode renders the photo without its crop, so it measures all of it.
  const scopeRegion = scopeSource === 'qualifier' && !editor.cropping ? qualified?.region : null
  const qualifyPoint = (x: number, y: number): void => {
    // A point measures a square of about 2 percent of the long edge, in preview pixels.
    const { width = 1, height = 1 } = editor.preview ?? {}
    const side = Math.max(width, height) * 0.02
    const w = Math.min(1, side / width)
    const h = Math.min(1, side / height)
    qualify({
      x: Math.max(0, Math.min(1 - w, x - w / 2)),
      y: Math.max(0, Math.min(1 - h, y - h / 2)),
      width: w,
      height: h
    })
  }
  const scopeProps = {
    // The scope reads its pixels after the developing cloud leaves.
    // The read would make the cloud skip frames.
    url: displayFile && !cloudFile && sidebarPage === 'edit' ? sourceUrl : undefined,
    region: scopeRegion,
    fileId: currentFile?.id,
    pending: !!cloudFile || editor.loading || (!!editor.viewport && !sourceUrl),
    mode: scope
  }
  // A tiny scope shows in the header while the full one is scrolled away.
  // An X3I that merges its SFD RAW shows the panel for the merge progress.
  const sidebarShown = panelOpen || editor.cropping || x3iPending
  const scopeBox = useRef<HTMLDivElement>(null)
  const [scopeHidden, setScopeHidden] = useState(false)
  useEffect(() => {
    const target = scopeBox.current
    if (!target || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setScopeHidden(!entry.isIntersecting), {
      root: sidebarBody.current
    })
    observer.observe(target)
    return () => {
      observer.disconnect()
      setScopeHidden(false)
    }
  }, [sidebarShown])
  const history = (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('editor.undo')}
        title={withShortcut(t('editor.undo'), 'Mod+Z')}
        disabled={unavailable || !doc?.past.length}
        onClick={editor.undo}
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('editor.redo')}
        title={withShortcut(t('editor.redo'), 'Mod+Shift+Z')}
        disabled={unavailable || !doc?.future.length}
        onClick={editor.redo}
      >
        <Redo2 className="h-4 w-4" />
      </Button>
    </>
  )
  const content = (
    <div className="flex h-full min-h-0 flex-col bg-tone-950">
      <div
        ref={swap.ref}
        data-tauri-drag-region
        className="window-toolbar flex h-12 shrink-0 items-center justify-between gap-2 border-b border-ink/10 px-3"
      >
        <div className="flex min-w-0 items-center gap-2">
          {!swap.shown && (
            <div data-swap className="contents" {...inert}>
              <FilterButton />
              <CullError />
              <div role="separator" aria-orientation="vertical" className="h-5 w-px bg-ink/15" />
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
                className="mx-1 h-5 w-px bg-ink/15"
              />
              {history}
              <div
                role="separator"
                aria-orientation="vertical"
                className="mx-1 h-5 w-px bg-ink/15"
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
                variant="ghost"
                size="icon"
                aria-label={t('editor.copy')}
                title={withShortcut(t('editor.copy'), 'Mod+C')}
                disabled={unavailable}
                onClick={editor.copy}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('editor.paste')}
                title={withShortcut(t('editor.paste'), 'Mod+V')}
                disabled={unavailable || !editor.clipboard}
                onClick={() => void editor.paste()}
              >
                <ClipboardPaste className="h-4 w-4" />
              </Button>
              <div
                role="separator"
                aria-orientation="vertical"
                className="mx-1 h-5 w-px bg-ink/15"
              />
              {/* Resets every adjustment; crop mode's Cancel could not undo it. */}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('editor.reset')}
                title={t('editor.reset')}
                disabled={unavailable}
                onClick={editor.reset}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              {history}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('editor.compare')}
                title={withShortcut(t('editor.compare'), '\\')}
                aria-pressed={editor.before}
                disabled={unavailable}
                onClick={() => editor.compare(!editor.before)}
              >
                <SquareSplitHorizontal className="h-4 w-4" />
              </Button>
              <Button
                ref={cropButton}
                variant="ghost"
                size="md"
                disabled={unavailable || x3iPending}
                onClick={enterCrop}
              >
                <Crop className="h-4 w-4" aria-hidden="true" />
                {t('editor.crop')}
              </Button>
              <div
                role="separator"
                aria-orientation="vertical"
                className="mx-1 h-5 w-px bg-ink/15"
              />
              <Button variant="ghost" size="md" disabled={busy} onClick={() => void editor.close()}>
                {t('editor.done')}
              </Button>
              <ExportButton
                disabled={unavailable || !file}
                ids={file && new Set([file.id])}
                returnScreen="editor"
              />
              <Button
                variant="ghost"
                size="icon"
                title={t('editor.togglePanel')}
                aria-label={t('editor.togglePanel')}
                aria-pressed={panelOpen}
                // The same gap as in the browser toolbar.
                className={cn('ml-1', panelOpen && 'bg-ink/15 text-tone-100')}
                onClick={() =>
                  void useSettingsStore.getState().update({ editorPanelOpen: !panelOpen })
                }
              >
                <PanelRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          )}
        </div>
      </div>
      {editor.error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-danger/20 bg-danger/10 px-4 py-2 text-xs text-danger"
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
      {filterOpen && <FilterBar />}
      <div className="flex min-h-0 flex-1">
        <FileFilmstrip
          preview={
            <div className="relative h-full w-full">
              {/* Always present, so turning the inversion on does not mount the preview again. */}
              <div className={cn('contents', inverted && '[&_canvas]:invert [&_img]:invert')}>
                {displayFile && editor.preview && doc && editor.cropping && !unavailable ? (
                  <CropPreview
                    preview={editor.preview}
                    recipe={doc.recipe}
                    locked={aspect !== 'free'}
                    inverted={inverted}
                    onDone={() => setCropping(false)}
                    onPaint={() => setPainted(true)}
                  />
                ) : previewFile ? (
                  <ZoomablePreview
                    key={file?.id}
                    file={previewFile}
                    naturalSize={naturalSize}
                    tile={editor.tile}
                    cache={editor.cache}
                    onCacheMiss={editor.uncache}
                    // A viewport asks for tiles only. The embedded preview keeps none, so the
                    // first render after the merge is a full preview.
                    onViewportChange={displayFile ? editor.setViewport : undefined}
                    onViewportMove={editor.holdPrefetch}
                    onPaint={(url) => {
                      setPainted(true)
                      setShownArea(
                        url === editor.preview?.url
                          ? `${editor.preview.sessionId}:${editor.previewGeometry}`
                          : null
                      )
                    }}
                    // Digits rate the photo, as in Lightroom. Click and +/- still zoom.
                    digitZoom={false}
                    onImagePoint={
                      picking && !unavailable
                        ? (x, y) => {
                            setPicking(false)
                            void editor.pickWhiteBalance(x, y)
                          }
                        : qualifying && displayFile
                          ? qualifyPoint
                          : undefined
                    }
                    onImageRegion={qualifying && displayFile ? qualify : undefined}
                    outline={displayFile ? scopeRegion : null}
                    selectionKey={shownArea}
                  />
                ) : cloudFile ? null : (
                  <div
                    role="status"
                    className="flex h-full items-center justify-center gap-2 text-xs text-tone-500"
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
              </div>
              {morph && displayFile && (
                <DevelopingPreview
                  key={`morph:${morph}`}
                  file={displayFile}
                  from={morph}
                  matching={false}
                  developing={editor.switching}
                  ready={!editor.switching}
                  onDone={() => setMorph(undefined)}
                />
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
        {/* Crop mode keeps the panel open for its controls. */}
        {sidebarShown && (
          <ResizablePanel kind="editor">
            <div className="z-10 flex h-8 shrink-0 items-center justify-between gap-2 border-b border-ink/10 px-3 font-mono text-xs uppercase tracking-[0.12em] text-tone-400">
              {sidebarPage === 'edit' ? (
                <>
                  <div className="ml-0.5 flex min-w-0 items-center gap-1.5">
                    {currentFile && <PhotoInfo file={currentFile} />}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {scopeHidden && <ColorScope {...scopeProps} compact />}
                    <ScopeMenu />
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-1">
                  {/* Shifted so the arrow lines up with the section text below. */}
                  <Button
                    ref={sidebarBack}
                    variant="ghost"
                    size="icon"
                    className="-ml-1 h-6 w-6"
                    aria-label={t('editor.backToAdjustments')}
                    title={t('editor.backToAdjustments')}
                    onClick={() => navigateSidebar('edit')}
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <h2>{t(sidebarPage === 'emulsion' ? 'editor.look' : 'editor.paperStock')}</h2>
                </div>
              )}
            </div>
            <div
              ref={sidebarBody}
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-3"
            >
              {sidebarPage === 'paper' && doc && (
                <fieldset
                  disabled={unavailable || editor.before || !!cloudFile}
                  className="contents"
                >
                  <LookPicker kind="paper" recipe={doc.recipe} gallery />
                </fieldset>
              )}
              {sidebarPage !== 'edit' && doc && (
                <div hidden={sidebarPage !== 'emulsion'}>
                  <fieldset
                    disabled={unavailable || editor.before || !!cloudFile}
                    className="contents"
                  >
                    <EmulsionControls key={editor.session?.sessionId} recipe={doc.recipe} />
                  </fieldset>
                </div>
              )}
              <div hidden={sidebarPage !== 'edit'}>
                <div ref={scopeBox} className="p-3">
                  <div
                    role="tablist"
                    aria-label={t('editor.scopeArea')}
                    className="mb-2 flex gap-1"
                  >
                    {SCOPE_SOURCES.map(([value, label], index) => (
                      <button
                        key={value}
                        id={`scope-tab-${value}`}
                        type="button"
                        role="tab"
                        aria-selected={scopeSource === value}
                        aria-controls="scope-panel"
                        aria-label={value === 'qualifier' ? t(`editor.${label}`) : undefined}
                        title={value === 'qualifier' ? t(`editor.${label}`) : undefined}
                        tabIndex={scopeSource === value ? 0 : -1}
                        onClick={() => chooseScope(value)}
                        onKeyDown={(event) => {
                          const count = SCOPE_SOURCES.length
                          const next =
                            event.key === 'ArrowRight'
                              ? (index + 1) % count
                              : event.key === 'ArrowLeft'
                                ? (index + count - 1) % count
                                : event.key === 'Home'
                                  ? 0
                                  : event.key === 'End'
                                    ? count - 1
                                    : -1
                          if (next < 0) return
                          event.preventDefault()
                          chooseScope(SCOPE_SOURCES[next][0])
                          document.getElementById(`scope-tab-${SCOPE_SOURCES[next][0]}`)?.focus()
                        }}
                        className={cn(
                          // As the sidebar tabs: the accent is below 4.5:1 contrast in the light
                          // and gray themes, so an armed Qualifier shows a stronger border and fill.
                          'control-label flex items-center rounded-md border border-transparent px-2 py-1 text-[10px] text-tone-300 hover:bg-ink/5 hover:text-tone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/70 aria-selected:border-ink/30 aria-selected:bg-ink/10 aria-selected:text-ink',
                          value === 'qualifier' && 'ml-auto',
                          value === 'qualifier' &&
                            qualifying &&
                            'aria-selected:border-ink/60 aria-selected:bg-ink/15'
                        )}
                      >
                        {value === 'qualifier' ? (
                          <Pipette aria-hidden="true" className="h-3.5 w-3.5" />
                        ) : (
                          t(`editor.${label}`)
                        )}
                      </button>
                    ))}
                  </div>
                  {/* While out of view, only the header scope renders. */}
                  <div
                    id="scope-panel"
                    role="tabpanel"
                    aria-labelledby={`scope-tab-${scopeSource}`}
                  >
                    <ColorScope {...scopeProps} paused={scopeHidden} />
                  </div>
                  {qualifying && (
                    <p role="status" className="control-label mt-2 text-[10px] text-tone-100">
                      {t('editor.scopeQualifyHint')}
                    </p>
                  )}
                </div>
                {doc && (
                  <>
                    {doc.storage === 'backup' && (
                      <p
                        role="status"
                        className="control-label px-4 py-1.5 text-[10px] text-tone-500"
                        title={doc.storagePath}
                      >
                        {t('editor.savedBackup')}
                      </p>
                    )}
                    {/* Without a render, the SFD RAW section of an X3I still works.
                        EditorControls keeps the other sections inert. */}
                    <fieldset
                      disabled={(unavailable && !x3iPending) || editor.before || !!cloudFile}
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
        )}
      </div>
    </div>
  )
  return <DevelopingCloud.Provider value={!!cloudFile}>{content}</DevelopingCloud.Provider>
}
