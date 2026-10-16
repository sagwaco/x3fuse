import { cloneElement, useEffect, useId, type HTMLAttributes, type ReactElement } from 'react'
import type { NativeMenuItem } from '@shared/ipc'
import { ipc } from '../lib/ipc'
import { invalidateNativeMenu, showNativeMenu } from '../lib/nativeMenu'
import { t } from '../lib/strings'
import { shownFiles, useQueueStore } from '../stores/queueStore'
import { useSettingsStore } from '../stores/settingsStore'
import { cull, cullTargets } from '../hooks/useCulling'

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
    // Without a selection, actions apply to the photos the filter shows.
    const targets = selected.length ? selected : shownFiles(store())
    const ids = new Set(targets.map((file) => file.id))
    const busy = isProcessing || isPreparing
    type Action = NativeMenuItem & { run: () => void; items?: Action[] }
    const actions: Action[] = [
      {
        value: 'convert',
        label: selected.length ? t('context.convert_selected') : t('context.convert_all'),
        disabled: busy || !targets.length || targets.some((file) => file.pending),
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
      disabled: busy || !targets.length,
      separatorBefore: true,
      run: () => store().removeFiles(ids)
    })
    // Flags and ratings apply to the same photos as the culling keys.
    const culled = cullTargets(store(), useSettingsStore.getState().settings.queueViewMode, 'queue')
    // The photos are fixed now; the selection can change before the menu returns.
    const culledIds = new Set(culled.map((file) => file.id))
    if (selected.length && culled.length) {
      const flags = new Set(culled.map((file) => file.flag ?? 'unflagged'))
      const ratings = new Set(culled.map((file) => file.rating ?? 0))
      actions.push(
        {
          value: 'flag',
          label: t('filter.flag'),
          separatorBefore: true,
          run: () => {},
          items: (['pick', 'reject', 'unflagged'] as const).map((flag) => ({
            value: `flag:${flag}`,
            label: t(`cull.${flag}`),
            checked: flags.size === 1 && flags.has(flag),
            run: () => cull({ flag }, { ids: culledIds })
          }))
        },
        {
          value: 'rating',
          label: t('filter.rating'),
          run: () => {},
          items: [0, 1, 2, 3, 4, 5].map((rating) => ({
            value: `rating:${rating}`,
            label: rating ? '★'.repeat(rating) : t('cull.no_rating'),
            checked: ratings.size === 1 && ratings.has(rating),
            run: () => cull({ rating }, { ids: culledIds })
          }))
        }
      )
    }
    if (selected.length) {
      actions.push(
        {
          value: 'reveal',
          separatorBefore: true,
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
    const items = (list: Action[]): NativeMenuItem[] =>
      list.map(({ run: _run, items: children, ...item }) =>
        children ? { ...item, items: items(children) } : item
      )
    void showNativeMenu({ id, x, y, items: items(actions) }, (value) => {
      const action = actions
        .flatMap((item) => item.items ?? [item])
        .find((item) => item.value === value)
      if (action && !action.disabled && !store().draft) action.run()
    }).catch((error: unknown) => console.error('Could not open native context menu', error))
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
