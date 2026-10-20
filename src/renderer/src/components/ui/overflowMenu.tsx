import { Ellipsis, type LucideIcon } from 'lucide-react'
import type { NativeMenuItem } from '@shared/ipc'
import { t } from '../../lib/strings'
import { NativeMenuButton } from './nativeMenuButton'

/** A toolbar button that moved into the overflow menu. */
export interface OverflowAction {
  id: string
  label: string
  icon: LucideIcon
  disabled?: boolean
  /** A pressed toggle shows a check mark. */
  pressed?: boolean
  /** An action with a menu of its own becomes a submenu. Its values reach `onSelect`. */
  items?: NativeMenuItem[]
  onSelect: (value?: string) => void
}

/** Native menu for the buttons that do not fit the toolbar. Shows nothing when all fit. */
export function OverflowMenu({
  actions,
  triggerRef
}: {
  /** In toolbar order. */
  actions: OverflowAction[]
  /** Lets the screen return keyboard focus to the menu button. */
  triggerRef?: React.Ref<HTMLButtonElement>
}): React.JSX.Element | null {
  if (actions.length === 0) return null
  return (
    <NativeMenuButton
      buttonRef={triggerRef}
      variant="ghost"
      size="icon"
      title={t('toolbar.more')}
      aria-label={t('toolbar.more')}
      items={actions.map(({ id, label, icon, disabled, pressed, items }): NativeMenuItem => ({
        value: id,
        label,
        icon,
        disabled,
        ...(items
          ? { items: items.map((item) => ({ ...item, value: `${id}:${item.value}` })) }
          : pressed === undefined
            ? {}
            : { checked: pressed })
      }))}
      onSelect={(value) => {
        const [id, ...sub] = value.split(':')
        actions.find((action) => action.id === id)?.onSelect(sub.length ? sub.join(':') : undefined)
      }}
    >
      <Ellipsis className="h-4 w-4" aria-hidden="true" />
    </NativeMenuButton>
  )
}
