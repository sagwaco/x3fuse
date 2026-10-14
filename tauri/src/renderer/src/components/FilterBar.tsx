import { ChevronDown, Flag as FlagIcon, FlagOff } from 'lucide-react'
import type { Flag } from '@shared/types'
import { isFiltering, NO_FILTER, shownCount, type CullFilter } from '../lib/culling'
import { t } from '../lib/strings'
import { useQueueStore } from '../stores/queueStore'
import { Button } from './ui/button'
import { StarPicker } from './CullControls'
import { NativeMenuButton } from './ui/nativeMenuButton'

const FLAGS: { flag: Flag; icon: React.ReactNode }[] = [
  { flag: 'pick', icon: <FlagIcon aria-hidden="true" className="h-4 w-4 fill-current" /> },
  { flag: 'unflagged', icon: <FlagIcon aria-hidden="true" className="h-4 w-4" /> },
  { flag: 'reject', icon: <FlagOff aria-hidden="true" className="h-4 w-4" /> }
]

const OPS: Record<CullFilter['ratingOp'], string> = { atLeast: '≥', exactly: '=', atMost: '≤' }

/** Library filter: shows photos by flag and star rating. Hidden photos keep their values. */
export function FilterBar(): React.JSX.Element {
  const filter = useQueueStore((s) => s.filter)
  const setFilter = useQueueStore((s) => s.setFilter)
  const total = useQueueStore((s) => s.files.length)
  const shown = useQueueStore((s) => shownCount(s.files, s.filter))

  return (
    <div
      role="toolbar"
      aria-label={t('filter.toggle')}
      className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3 text-xs text-neutral-400"
    >
      <span>{t('filter.flag')}</span>
      <div className="flex items-center gap-0.5">
        {FLAGS.map(({ flag, icon }) => (
          <Button
            key={flag}
            variant="ghost"
            size="icon"
            title={t(`cull.${flag}`)}
            aria-label={t(`cull.${flag}`)}
            aria-pressed={filter.flags.includes(flag)}
            onClick={() =>
              setFilter({
                flags: filter.flags.includes(flag)
                  ? filter.flags.filter((other) => other !== flag)
                  : [...filter.flags, flag]
              })
            }
          >
            {icon}
          </Button>
        ))}
      </div>
      <div role="separator" aria-orientation="vertical" className="mx-1 h-5 w-px bg-white/15" />
      <span>{t('filter.rating')}</span>
      <NativeMenuButton
        variant="ghost"
        size="md"
        className="gap-1 px-2 tabular-nums"
        aria-label={t(`filter.${filter.ratingOp}`)}
        title={t(`filter.${filter.ratingOp}`)}
        items={(Object.keys(OPS) as CullFilter['ratingOp'][]).map((op) => ({
          value: op,
          label: `${OPS[op]}  ${t(`filter.${op}`)}`,
          checked: op === filter.ratingOp
        }))}
        onSelect={(value) => setFilter({ ratingOp: value as CullFilter['ratingOp'] })}
      >
        {OPS[filter.ratingOp]}
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </NativeMenuButton>
      <StarPicker value={filter.rating} onChange={(rating) => setFilter({ rating })} />
      <span className="ml-auto font-mono tabular-nums">{t('filter.count', { shown, total })}</span>
      {isFiltering(filter) && (
        <Button variant="ghost" size="sm" onClick={() => setFilter(NO_FILTER)}>
          {t('filter.clear')}
        </Button>
      )}
    </div>
  )
}
