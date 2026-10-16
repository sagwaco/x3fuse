import type { QueueViewMode } from '@shared/types'
import { NO_FILTER, shownCount } from '../lib/culling'
import { t } from '../lib/strings'
import { useQueueStore, type ExportDraft } from '../stores/queueStore'
import { FileQueue } from './FileQueue'
import { FileGrid } from './FileGrid'
import { FileFilmstrip } from './FileFilmstrip'
import { SurveyView } from './SurveyView'
import { Button } from './ui/button'

export function QueueView({
  mode,
  draft
}: {
  mode: QueueViewMode
  draft?: ExportDraft
}): React.JSX.Element {
  const allHidden = useQueueStore(
    (s) => !draft && s.files.length > 0 && shownCount(s.files, s.filter) === 0
  )
  if (allHidden)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-tone-400">
        {t('filter.empty')}
        <Button onClick={() => useQueueStore.getState().setFilter(NO_FILTER)}>
          {t('filter.clear')}
        </Button>
      </div>
    )
  switch (mode) {
    case 'survey':
      return draft ? <FileGrid draft={draft} /> : <SurveyView />
    case 'grid':
      return <FileGrid draft={draft} />
    case 'filmstrip':
      return <FileFilmstrip draft={draft} />
    default:
      return <FileQueue draft={draft} />
  }
}
