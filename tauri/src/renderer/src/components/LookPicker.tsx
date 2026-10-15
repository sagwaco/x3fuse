import { Fragment, useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  DEFAULT_FILM,
  FILM_MONOCHROME_FILTERS,
  filmHalationDefaults,
  type EditRecipe
} from '@shared/editor'
import stocks from '@shared/film-stocks.json'
import { useEditorStore } from '../stores/editorStore'
import { t } from '../lib/strings'
import { HelpTooltip } from './ui/settingsLayout'

type Stock = (typeof stocks)[number]
const FAMILIES = ['negativeFilm', 'slideFilm', 'cinemaFilm', 'bwFilm']
const family = (stock: Stock): string =>
  stock.monochrome
    ? 'bwFilm'
    : stock.isPositive
      ? 'slideFilm'
      : stock.targetPaperKey === 'kodak_2383'
        ? 'cinemaFilm'
        : 'negativeFilm'
const FILMS = stocks
  .filter((stock) => !stock.isPaper)
  .sort((a, b) => FAMILIES.indexOf(family(a)) - FAMILIES.indexOf(family(b)))
const PAPERS = stocks.filter((stock) => stock.isPaper)
/** Black-and-white film prints only on black-and-white paper, and color on color. */
const sameModel = (a: Stock | undefined, b: Stock): boolean => !!a?.monochrome === !!b.monochrome

interface Look {
  id: string
  name: string
  group?: string
  recipe: EditRecipe
}

// ponytail: cleared wholesale past 300 entries; use an LRU if browsing ever thrashes it.
const rendered = new Map<string, string>()

/** Render each look's thumbnail in turn while the editor is idle. */
function useThumbnails(looks: Look[]): [Record<string, string | undefined>, (id: string) => void] {
  const sessionId = useEditorStore((state) => state.session?.sessionId)
  const idle = useEditorStore(
    (state) => !state.rendering && !state.prefetching && !!state.preview && !state.cropping
  )
  const renderThumbnail = useEditorStore((state) => state.renderThumbnail)
  const [latest, setLatest] = useState<Record<string, string>>({})
  const [attempt, setAttempt] = useState(0)
  const keyed = looks.map((look) => ({
    ...look,
    key: `${sessionId}:${JSON.stringify(look.recipe)}`
  }))
  const signature = keyed.map((look) => look.key).join('|')
  useEffect(() => {
    if (!idle || !signature) return
    let stopped = false
    // Let refinement of the main preview go first; any edit preempts a thumbnail.
    const timer = setTimeout(async () => {
      for (const look of keyed) {
        if (stopped) return
        if (rendered.has(look.key)) continue
        const url = await renderThumbnail(look.recipe).catch(() => null)
        if (!url) return
        if (rendered.size > 300) rendered.clear()
        rendered.set(look.key, url)
        if (!stopped) setLatest((previous) => ({ ...previous, [look.id]: url }))
      }
    }, 250)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // `signature` captures every recipe in `keyed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idle, signature, renderThumbnail, attempt])
  // Keep showing a look's previous thumbnail until its updated one arrives.
  const thumbnails = Object.fromEntries(
    keyed.map((look) => [look.id, rendered.get(look.key) ?? latest[look.id]])
  )
  // The backend's preview cache can evict a thumbnail; render it again.
  const forget = (id: string): void => {
    rendered.forEach((url, key) => url === thumbnails[id] && rendered.delete(key))
    setLatest(({ [id]: _, ...rest }) => rest)
    setAttempt((value) => value + 1)
  }
  return [thumbnails, forget]
}

/** Film or print paper, picked from previews of the current photo. */
export function LookPicker({
  kind,
  recipe,
  gallery = false,
  onOpen
}: {
  kind: 'film' | 'paper'
  recipe: EditRecipe
  gallery?: boolean
  onOpen?: () => void
}): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  const cameraProfiles = useEditorStore((state) => state.session?.cameraProfiles)
  const base = recipe.film ?? DEFAULT_FILM
  const filter = recipe.monochrome?.filter ?? 'neutral'
  // A stock comes with the print paper it was designed for, else keeps a paper it can print on.
  const paper = (stock: Stock): number =>
    (PAPERS.find((candidate) => candidate.key === stock.targetPaperKey) ??
      PAPERS.find((candidate) => candidate.index === base.paper && sameModel(candidate, stock)) ??
      PAPERS.find((candidate) => sameModel(candidate, stock)))!.index
  const looks: Look[] =
    kind === 'film'
      ? [
          ...[
            { id: 'Standard', name: t('editor.standard') },
            { id: 'Monochrome', name: t('editor.monochrome') },
            ...(cameraProfiles ?? []).filter(
              (profile) => !['Standard', 'Monochrome'].includes(profile.id)
            )
          ].map((profile) => ({
            id: profile.id,
            name: profile.name,
            group: t('editor.cameraMatching'),
            recipe: {
              ...recipe,
              film: null,
              cameraProfile: profile.id,
              monochrome: profile.id === 'Monochrome' ? { filter } : null
            }
          })),
          ...FILMS.map((stock) => ({
            id: stock.key,
            name: stock.name,
            group: t(`editor.${family(stock)}`),
            recipe: {
              ...recipe,
              // Film stocks use their own color response, without a camera look.
              cameraProfile: null,
              // Positive film is scanned directly, without a print.
              film: {
                ...base,
                ...(recipe.film && base.film === stock.index
                  ? {}
                  : filmHalationDefaults(stock.index)),
                film: stock.index,
                paper: paper(stock),
                negative: stock.isPositive
              },
              monochrome: stock.monochrome
                ? { filter: FILM_MONOCHROME_FILTERS.includes(filter) ? filter : 'neutral' }
                : null
            }
          }))
        ]
      : PAPERS.filter((stock) =>
          sameModel(
            FILMS.find((film) => film.index === base.film),
            stock
          )
        )
          .map((stock) => ({
            id: stock.key,
            name: stock.name,
            recipe: { ...recipe, film: { ...base, paper: stock.index, negative: false } }
          }))
          // Without a print, the film itself is scanned.
          .concat({
            id: 'negative',
            name: t('editor.negativePrint'),
            recipe: { ...recipe, film: { ...base, negative: true } }
          })
  const cameraProfile = recipe.cameraProfile ?? 'Standard'
  const selected =
    kind === 'paper'
      ? base.negative
        ? 'negative'
        : PAPERS.find((stock) => stock.index === base.paper)?.key
      : recipe.film
        ? FILMS.find((stock) => stock.index === recipe.film?.film)?.key
        : recipe.monochrome
          ? 'Monochrome'
          : looks.some((look) => look.id === cameraProfile)
            ? cameraProfile
            : 'Standard'
  const [thumbnails, forget] = useThumbnails(gallery ? looks : [])
  const caption = t(kind === 'film' ? 'editor.filmStock' : 'editor.paperStock')
  if (gallery)
    return (
      <div role="group" aria-label={caption} className="grid grid-cols-3 gap-x-2 gap-y-3 p-4">
        {looks.map((look, index) => (
          <Fragment key={look.id}>
            {look.group && look.group !== looks[index - 1]?.group && (
              <h2 className="control-label col-span-3 pt-1 text-[10px] font-bold text-neutral-400">
                {look.group}
              </h2>
            )}
            <button
              type="button"
              aria-pressed={look.id === selected}
              onClick={() =>
                change({
                  film: look.recipe.film,
                  monochrome: look.recipe.monochrome,
                  cameraProfile: look.recipe.cameraProfile
                })
              }
              className="group self-start rounded-md text-left focus-visible:outline-none disabled:opacity-50"
            >
              <span className="look-thumbnail relative block aspect-[3/2] overflow-hidden rounded-md bg-white/[0.06] group-hover:ring-1 group-hover:ring-white/30 group-focus-visible:ring-2 group-focus-visible:ring-white/60 group-aria-pressed:ring-2 group-aria-pressed:ring-white">
                {thumbnails[look.id] && (
                  <img
                    src={thumbnails[look.id]}
                    alt=""
                    draggable={false}
                    className="h-full w-full object-cover"
                    onError={() => forget(look.id)}
                  />
                )}
              </span>
              <span className="mt-1 line-clamp-2 block text-[10px] leading-tight text-neutral-300 group-aria-pressed:text-white">
                {look.name}
              </span>
            </button>
          </Fragment>
        ))}
      </div>
    )
  return (
    <div className="relative flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2.5 hover:border-white/25 has-[:disabled]:opacity-50">
      {/* The button's ::after covers the box, so all of it opens the picker. */}
      <button
        type="button"
        data-sidebar-page={kind}
        onClick={onOpen}
        className="min-w-0 flex-1 text-left after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-white/50"
      >
        <span className="control-label block text-[10px] tracking-[0.14em] text-neutral-500">
          {caption}
        </span>
        <span className="block truncate text-[13px] text-neutral-100">
          {looks.find((look) => look.id === selected)?.name}
        </span>
      </button>
      {kind === 'film' && (
        // Positioned after the button, so it sits above the button's ::after.
        <span className="relative">
          <HelpTooltip label={caption} text={t('editor.filmHelp')} />
        </span>
      )}
      <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
    </div>
  )
}
