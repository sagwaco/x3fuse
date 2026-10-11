import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type Variant = 'prominent' | 'bordered' | 'ghost' | 'destructive'
type Size = 'sm' | 'md' | 'icon'

const VARIANTS: Record<Variant, string> = {
  prominent: 'bg-white text-black hover:bg-neutral-200 active:bg-neutral-300 disabled:bg-white/40',
  bordered:
    'border border-white/15 bg-white/[0.03] text-neutral-200 hover:border-white/25 hover:bg-white/10 active:bg-white/15 aria-pressed:border-white/30 aria-pressed:bg-white/15 aria-pressed:text-white',
  ghost:
    'text-neutral-300 hover:bg-white/10 hover:text-neutral-100 aria-pressed:bg-white/15 aria-pressed:text-neutral-100',
  destructive: 'border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20'
}

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[11px] gap-1.5',
  md: 'h-8 px-3 text-xs gap-2',
  icon: 'h-8 w-8 justify-center'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'bordered', size = 'md', className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex select-none items-center rounded-lg font-mono font-medium uppercase tracking-[0.1em] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    />
  )
})
