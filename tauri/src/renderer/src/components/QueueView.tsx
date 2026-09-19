import type { QueueViewMode } from '@shared/types'
import type { ExportDraft } from '../stores/queueStore'
import { FileQueue } from './FileQueue'
import { FileGrid } from './FileGrid'
import { FileFilmstrip } from './FileFilmstrip'

export function QueueView({
  mode,
  draft
}: {
  mode: QueueViewMode
  draft?: ExportDraft
}): React.JSX.Element {
  switch (mode) {
    case 'grid':
      return <FileGrid draft={draft} />
    case 'filmstrip':
      return <FileFilmstrip draft={draft} />
    default:
      return <FileQueue draft={draft} />
  }
}
