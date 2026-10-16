import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Conditional className helper (clsx + tailwind-merge), shadcn-style. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
