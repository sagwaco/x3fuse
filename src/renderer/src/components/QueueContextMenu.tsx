import { cloneElement, useEffect, useId, type HTMLAttributes, type ReactElement } from 'react'
import type { MenuCommand } from '@shared/ipc'
import type { OutputFormat } from '@shared/types'
import { ipc } from '../lib/ipc'
import { invalidateNativeMenu } from '../lib/nativeMenu'
import { cullActions, keyOf, labelOf, showActions, type MenuAction } from '../lib/menuActions'
import { t } from '../lib/strings'
import { renderedOnly, shownFiles, useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useEditorStore } from '../stores/editorStore'
import { cullTargets } from '../hooks/useCulling'
import { useExportMenu } from '../hooks/useExportMenu'

const PRESETS: Record<string, MenuCommand> = {
  jpeg: 'exportJpeg',
  embeddedJpg: 'exportEmbeddedJpg',
  dng: 'exportDng',
  tiff: 'exportTiff'
}

/** Shares native context actions across list, grid, and filmstrip surfaces. */
export function QueueContextMenu({
  children,
  disabled = false
}: {
  children: ReactElement<HTMLAttributes<HTMLElement>>
  disabled?: boolean
}): React.JSX.Element {
  const id = useId()
  useEffect(() => () => invalidateNativeMenu(id), [id, disabled])
  const exportItems = useExportMenu().items

  function show(x: number, y: number): void {
    const store = useQueueStore.getState
    const { files, selectedIds, activeId, isProcessing, isPreparing, isCancelling, draft } = store()
    if (disabled || draft) return
    const selected = files.filter((file) => selectedIds.has(file.id))
    // Without a selection, actions apply to the photos the filter shows.
    const targets = selected.length ? selected : shownFiles(store())
    const ids = new Set(targets.map((file) => file.id))
    const busy = isProcessing || isPreparing
    // A right-click makes the photo under the pointer the active one.
    const active = selected.find((file) => file.id === activeId)
    const actions: MenuAction[] = []
    if (active)
      actions.push({
        value: 'edit',
        label: labelOf('editPhoto'),
        accelerator: keyOf('editPhoto'),
        disabled: busy || !!active.pending,
        run: () => {
          // The editor shows the active photo, and the selection can change while the menu
          // is open.
          store().setSelection(new Set([...store().selectedIds, active.id]), active.id)
          void useEditorStore.getState().open(active)
        }
      })
    // Flags and ratings apply to the same photos as the culling keys.
    const culled = cullTargets(store(), useSettingsStore.getState().settings.queueViewMode, 'queue')
    // The photos are fixed now; the selection can change before the menu returns.
    if (selected.length && culled.length) actions.push(...cullActions(culled))
    if (selected.length)
      actions.push(
        {
          value: 'copy',
          label: labelOf('copyEdits'),
          accelerator: keyOf('copyEdits'),
          separatorBefore: true,
          // Copy takes the active photo's adjustments.
          disabled: busy || !active?.edit,
          run: () => useEditorStore.getState().copy(active)
        },
        {
          value: 'paste',
          label: labelOf('pasteEdits'),
          accelerator: keyOf('pasteEdits'),
          disabled: busy || !useEditorStore.getState().clipboard,
          run: () => void useEditorStore.getState().paste(selected)
        }
      )
    const previous = exportItems.find((item) => item.value === 'previous')!
    actions.push({
      value: 'export',
      label: t('context.convert'),
      separatorBefore: true,
      disabled: busy || !targets.length || targets.some((file) => file.pending),
      run: () => {},
      items: [
        {
          value: 'export:screen',
          label: labelOf('exportSelected'),
          accelerator: keyOf('exportSelected'),
          run: () => (selected.length ? store().openExport(ids) : store().convertAllMenu())
        },
        {
          value: 'export:previous',
          label: previous.label,
          disabled: previous.disabled,
          accelerator: keyOf('exportPrevious'),
          run: () => void store().convertPrevious(ids)
        },
        ...exportItems
          .filter((item) => item !== previous)
          .map((item, index) => ({
            value: `export:${item.value}`,
            label: item.label,
            accelerator: keyOf(PRESETS[item.value]),
            separatorBefore: index === 0,
            // A DNG has no original export.
            disabled:
              (item.value === 'dng' || item.value === 'embeddedJpg') && targets.some(renderedOnly),
            run: () => void store().exportPreset(item.value as OutputFormat, ids)
          }))
      ]
    })
    if (isProcessing && !isCancelling) {
      actions.push({
        value: 'stop',
        label: labelOf('stop'),
        accelerator: keyOf('stop'),
        run: () => store().stop()
      })
    }
    if (selected.length)
      actions.push({
        value: 'reveal',
        separatorBefore: true,
        label: labelOf('showInFinder'),
        accelerator: keyOf('showInFinder'),
        run: () =>
          selected.forEach((file) => {
            void ipc.invoke('shell:reveal', { path: file.path }).catch((error: unknown) => {
              console.error('Could not reveal file', error)
            })
          })
      })
    actions.push({
      value: 'remove',
      label: selected.length ? t('context.remove_selected') : t('context.remove_all'),
      disabled: busy || !targets.length,
      separatorBefore: true,
      run: () => store().removeFiles(ids)
    })
    if (selected.length)
      actions.push({
        value: 'deselect',
        label: labelOf('deselectAll'),
        accelerator: keyOf('deselectAll'),
        run: () => store().deselectAll()
      })
    showActions(id, x, y, actions, () => !!store().draft)
  }

  if (disabled) return children
  return cloneElement(children, {
    onContextMenu: (event) => {
      // Let row and container handlers finish updating selection before reading it.
      children.props.onContextMenu?.(event)
      if (event.defaultPrevented) return
      event.preventDefault()
      show(event.clientX, event.clientY)
    },
    onKeyDown: (event) => {
      children.props.onKeyDown?.(event)
      if (
        event.defaultPrevented ||
        !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
      )
        return
      event.preventDefault()
      const bounds = (event.target as HTMLElement).getBoundingClientRect()
      show(bounds.left, bounds.top)
    }
  })
}
