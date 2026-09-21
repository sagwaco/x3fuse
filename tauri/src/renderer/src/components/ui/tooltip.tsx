import * as RadixTooltip from '@radix-ui/react-tooltip'
import type { ReactElement } from 'react'
import { cn } from '../../lib/cn'

export function Tooltip({
  text,
  children,
  side = 'top',
  className
}: {
  text?: string
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  className?: string
}): React.JSX.Element {
  if (!text) return children

  return (
    <RadixTooltip.Provider delayDuration={200}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={8}
            collisionPadding={12}
            className={cn(
              'app-tooltip z-[60] max-w-[min(24rem,var(--radix-tooltip-content-available-width))] whitespace-pre-wrap break-words rounded-xl border border-white/15 px-2 py-1.5 text-xs leading-tight text-neutral-100 shadow-xl',
              className
            )}
          >
            {text}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  )
}
