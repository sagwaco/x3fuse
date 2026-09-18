import type { X3FFileDTO } from '@shared/types'
import { isQueued } from './fileStatus'

/**
 * Convert the current selection, or the whole queue when nothing is selected,
 * filtering only an unselected queue when "Only convert new items" is enabled.
 *
 * Shared so the Export review screen previews exactly the files convertToolbar
 * will process.
 */
export function resolveConvertTargets(
  files: X3FFileDTO[],
  selectedIds: Set<string>,
  onlyProcessNewItems: boolean
): X3FFileDTO[] {
  if (selectedIds.size > 0) return files.filter((f) => selectedIds.has(f.id))
  return onlyProcessNewItems ? files.filter(isQueued) : files
}
