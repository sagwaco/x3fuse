import type { SortField, X3FFileDTO } from '@shared/types'

/**
 * Sort the queue, porting FileQueueSortingUtilities.sortFiles. File Name uses
 * case-insensitive locale compare; Date/Size compare the nullable fields with
 * distant-past / 0 fallbacks (sortableCapturedDate / sortableFileSize).
 */
export function sortFiles(files: X3FFileDTO[], field: SortField, ascending: boolean): X3FFileDTO[] {
  const sorted = [...files].sort((a, b) => compare(a, b, field))
  if (!ascending) sorted.reverse()
  if (field === 'File Name') return sorted
  // Placeholders do not have a date or size yet. They stay after the loaded photos in
  // import order, so that loaded photos fill in from the start of the view.
  return [...sorted.filter((file) => !file.pending), ...files.filter((file) => file.pending)]
}

function compare(a: X3FFileDTO, b: X3FFileDTO, field: SortField): number {
  switch (field) {
    case 'Date':
      return capturedMs(a) - capturedMs(b)
    case 'Size':
      return (a.fileSize ?? 0) - (b.fileSize ?? 0)
    case 'File Name':
    default:
      return ci(a.fileName, b.fileName)
  }
}

const collator = new Intl.Collator(undefined, { sensitivity: 'accent' })
function ci(a: string, b: string): number {
  return collator.compare(a, b)
}

function capturedMs(f: X3FFileDTO): number {
  if (!f.capturedDate) return -Infinity // Date.distantPast
  const t = new Date(f.capturedDate).getTime()
  return Number.isNaN(t) ? -Infinity : t
}
