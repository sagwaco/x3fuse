import {
  CheckCircle2,
  CircleDashed,
  FileClock,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import type { ConversionStatus, X3FFileDTO } from '@shared/types'
import { t } from './strings'

/** Display label for a status (port of X3FFile.displayStatus / sort key). */
export function statusLabel(status: ConversionStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'processing':
      return 'Processing...'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'warning':
      return 'Warning'
  }
}

interface StatusVisual {
  icon: LucideIcon
  /** Tailwind text-color class (port of X3FFile.statusIconColor). */
  color: string
}

/**
 * Icon + color per status, porting X3FFile.statusIcon/statusIconColor. The SF
 * Symbols map to the closest lucide icons:
 *   queued     document.badge.ellipsis              -> FileClock
 *   completed  checkmark.circle.fill                -> CheckCircle2 (green)
 *   failed     exclamationmark.triangle.fill        -> TriangleAlert (red)
 *   warning    checkmark.circle.trianglebadge…      -> TriangleAlert (orange)
 * (processing renders a spinner instead — see StatusIcon.)
 */
export function statusVisual(status: ConversionStatus): StatusVisual {
  switch (status) {
    case 'queued':
      return { icon: FileClock, color: 'text-neutral-200' }
    case 'processing':
      return { icon: CircleDashed, color: 'text-blue-400' }
    case 'completed':
      return { icon: CheckCircle2, color: 'text-green-500' }
    case 'failed':
      return { icon: TriangleAlert, color: 'text-red-500' }
    case 'warning':
      return { icon: TriangleAlert, color: 'text-orange-400' }
  }
}

/** Tooltip text for a file's status (port of StatusIconView.tooltipText). */
export function statusTooltip(file: X3FFileDTO): string {
  switch (file.status) {
    case 'failed':
      return file.errorMessage ?? t('status.conversion_failed')
    case 'warning':
      return file.warningMessage ?? t('status.conversion_completed_with_warnings')
    default:
      return statusLabel(file.status)
  }
}

export const isReconvertable = (f: X3FFileDTO): boolean =>
  f.status === 'completed' || f.status === 'failed' || f.status === 'warning'

export const isQueued = (f: X3FFileDTO): boolean => f.status === 'queued'
