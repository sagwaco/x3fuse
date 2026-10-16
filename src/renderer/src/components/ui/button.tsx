import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type Variant = 'prominent' | 'bordered' | 'ghost' | 'destructive'
type Size = 'sm' | 'md' | 'icon'

const VARIANTS: Record<Variant, string> = {
  prominent: 'bg-ink text-tone-950 hover:bg-tone-200 active:bg-tone-300 disabled:bg-ink/40',
  bordered:
    'border border-ink/15 bg-ink/[0.03] text-tone-200 hover:border-ink/25 hover:bg-ink/10 active:bg-ink/15 aria-pressed:border-ink/30 aria-pressed:bg-ink/15 aria-pressed:text-ink',
  ghost:
    'text-tone-300 hover:bg-ink/10 hover:text-tone-100 aria-pressed:bg-ink/15 aria-pressed:text-tone-100',
  destructive: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20'
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
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/50',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    />
  )
})
