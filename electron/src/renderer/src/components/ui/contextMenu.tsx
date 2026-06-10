import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { forwardRef } from 'react'
import { cn } from '../../lib/cn'

export const ContextMenu = ContextMenuPrimitive.Root
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger

export const ContextMenuContent = forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(function ContextMenuContent({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        ref={ref}
        className={cn(
          'z-50 min-w-[12rem] overflow-hidden rounded-md border border-white/10',
          'bg-neutral-900 p-1 shadow-xl',
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
})

export const ContextMenuItem = forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>
>(function ContextMenuItem({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm',
        'text-neutral-200 outline-none',
        'data-[highlighted]:bg-blue-600 data-[highlighted]:text-white',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        className
      )}
      {...props}
    />
  )
})

export function ContextMenuSeparator(): React.JSX.Element {
  return <ContextMenuPrimitive.Separator className="my-1 h-px bg-white/10" />
}
