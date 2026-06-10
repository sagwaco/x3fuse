import type { SortField, X3FFileDTO } from '@shared/types'
import { statusLabel } from './fileStatus'

/**
 * Sort the queue, porting FileQueueSortingUtilities.sortFiles. File Name and
 * Status use case-insensitive locale compare; Date/Size compare the nullable
 * fields with distant-past / 0 fallbacks (sortableCapturedDate / sortableFileSize).
 */
export function sortFiles(
  files: X3FFileDTO[],
  field: SortField,
  ascending: boolean
): X3FFileDTO[] {
  const sorted = [...files].sort((a, b) => compare(a, b, field))
  return ascending ? sorted : sorted.reverse()
}

function compare(a: X3FFileDTO, b: X3FFileDTO, field: SortField): number {
  switch (field) {
    case 'Status':
      return ci(statusLabel(a.status), statusLabel(b.status))
    case 'Date':
      return capturedMs(a) - capturedMs(b)
    case 'Size':
      return (a.fileSize ?? 0) - (b.fileSize ?? 0)
    case 'File Name':
    default:
      return ci(a.fileName, b.fileName)
  }
}

function ci(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' })
}

function capturedMs(f: X3FFileDTO): number {
  if (!f.capturedDate) return -Infinity // Date.distantPast
  const t = new Date(f.capturedDate).getTime()
  return Number.isNaN(t) ? -Infinity : t
}
