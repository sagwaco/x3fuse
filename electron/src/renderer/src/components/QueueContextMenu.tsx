import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from './ui/contextMenu'
import { QueueContextMenuItems } from './QueueContextMenuItems'

/**
 * Wraps a queue view's scroll surface in the Radix context menu. The single
 * child (the surface element) becomes the trigger via `asChild`, so list, grid,
 * and filmstrip all share one menu definition.
 */
export function QueueContextMenu({ children }: { children: React.ReactElement }): React.JSX.Element {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <QueueContextMenuItems />
      </ContextMenuContent>
    </ContextMenu>
  )
}
