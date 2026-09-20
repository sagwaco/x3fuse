import { cloneElement, useEffect, useId, type HTMLAttributes, type ReactElement } from 'react'
import type { NativeMenuItem } from '@shared/ipc'
import { ipc } from '../lib/ipc'
import { invalidateNativeMenu, showNativeMenu } from '../lib/nativeMenu'
import { t } from '../lib/strings'
import { useQueueStore } from '../stores/queueStore'

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

  function show(x: number, y: number): void {
    const store = useQueueStore.getState
    const { files, selectedIds, isProcessing, isPreparing, isCancelling, draft } = store()
    if (disabled || draft) return
    const selected = files.filter((file) => selectedIds.has(file.id))
    const targets = selected.length ? selected : files
    const ids = new Set(targets.map((file) => file.id))
    const busy = isProcessing || isPreparing
    const actions: (NativeMenuItem & { run: () => void })[] = [
      {
        value: 'convert',
        label: selected.length ? t('context.convert_selected') : t('context.convert_all'),
        disabled: busy || !files.length || targets.some((file) => file.pending),
        run: () => (selected.length ? store().openExport(ids) : store().convertAllMenu())
      }
    ]
    if (isProcessing && !isCancelling) {
      actions.push({
        value: 'stop',
        label: t('context.stop_conversion'),
        run: () => store().stop()
      })
    }
    actions.push({
      value: 'remove',
      label: selected.length ? t('context.remove_selected') : t('context.remove_all'),
      disabled: busy || !files.length,
      separatorBefore: true,
      run: () => store().removeFiles(ids)
    })
    if (selected.length) {
      actions.push(
        {
          value: 'reveal',
          label: t('context.show_in_finder'),
          run: () =>
            selected.forEach((file) => {
              void ipc.invoke('shell:reveal', { path: file.path }).catch((error: unknown) => {
                console.error('Could not reveal file', error)
              })
            })
        },
        { value: 'deselect', label: t('context.deselect_all'), run: () => store().deselectAll() }
      )
    }
    void showNativeMenu(
      { id, x, y, items: actions.map(({ run: _run, ...item }) => item) },
      (value) => {
        const action = actions.find((item) => item.value === value)
        if (action && !action.disabled && !store().draft) action.run()
      }
    ).catch((error: unknown) => console.error('Could not open native context menu', error))
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
