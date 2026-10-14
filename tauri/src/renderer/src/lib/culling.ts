import type { Flag, SortField, X3FFileDTO } from '@shared/types'
import { sortFiles } from './sortFiles'

/** Shows photos by flag and star rating. Hidden photos keep their metadata. */
export interface CullFilter {
  /** Flags to show. Empty shows all flags. */
  flags: Flag[]
  /** Star count to compare with `ratingOp`. 0 with 'atLeast' shows every rating. */
  rating: number
  ratingOp: 'atLeast' | 'exactly' | 'atMost'
}

export const NO_FILTER: CullFilter = { flags: [], rating: 0, ratingOp: 'atLeast' }

export const isFiltering = (filter: CullFilter): boolean =>
  filter.flags.length > 0 || filter.rating > 0 || filter.ratingOp !== 'atLeast'

export function matchesFilter(file: X3FFileDTO, filter: CullFilter): boolean {
  const rating = file.rating ?? 0
  if (filter.flags.length && !filter.flags.includes(file.flag ?? 'unflagged')) return false
  if (filter.ratingOp === 'exactly') return rating === filter.rating
  if (filter.ratingOp === 'atMost') return rating <= filter.rating
  return rating >= filter.rating
}

/** The photos that the filter shows, in on-screen order. */
export function visibleFiles(
  files: X3FFileDTO[],
  filter: CullFilter,
  field: SortField,
  ascending: boolean
): X3FFileDTO[] {
  return sortFiles(
    isFiltering(filter) ? files.filter((file) => matchesFilter(file, filter)) : files,
    field,
    ascending
  )
}

/**
 * The photo to show after `id` changes. It is the next shown photo in `order`. At the end
 * of the sequence, `id` stays when it is shown; otherwise the previous shown photo is used.
 */
export function successor(order: string[], id: string, shown: Set<string>): string | null {
  const index = order.indexOf(id)
  const next = order.slice(index + 1).find((other) => shown.has(other))
  if (next) return next
  if (shown.has(id)) return id
  return (
    order
      .slice(0, Math.max(0, index))
      .reverse()
      .find((other) => shown.has(other)) ?? null
  )
}

/** The column count that gives `count` tiles of `aspect` the largest size in the area. */
export function surveyColumns(count: number, width: number, height: number, aspect = 1.5): number {
  let best = 1
  let bestEdge = 0
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns)
    const edge = Math.min(width / columns / aspect, height / rows)
    if (edge > bestEdge) {
      best = columns
      bestEdge = edge
    }
  }
  return best
}

/** How many photos the filter shows. */
export const shownCount = (files: X3FFileDTO[], filter: CullFilter): number =>
  isFiltering(filter) ? files.filter((file) => matchesFilter(file, filter)).length : files.length
