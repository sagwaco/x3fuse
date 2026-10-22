import { Fragment, useContext, useEffect, useState } from 'react'
import {
  Camera,
  ChevronRight,
  Clapperboard,
  Contrast,
  Film,
  Info,
  Projector,
  Rainbow,
  type LucideIcon
} from 'lucide-react'
import {
  AEROCHROME_MATRIX,
  DEFAULT_FILM,
  IDENTITY_RAW_MATRIX,
  FILM_MONOCHROME_FILTERS,
  filmGrainDefaults,
  filmHalationDefaults,
  boundedWhiteBalanceGains,
  type EditRecipe
} from '@shared/editor'
import stocks from '@shared/film-stocks.json'
import { useEditorStore, previewCurrent } from '../stores/editorStore'
import { t } from '../lib/strings'
import { blurOnClick } from '../lib/commitFocus'
import { DevelopingCloud } from '../lib/developingCloud'
import { GlassGroup } from './ui/glassGroup'
import { Tooltip } from './ui/tooltip'
import { FilmCanister } from './FilmCanister'

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
const AEROCHROME_FILM = FILMS.find((stock) => stock.key === 'kodak_ektachrome_100')!
/** Black-and-white film prints only on black-and-white paper, and color on color. */
const sameModel = (a: Stock | undefined, b: Stock): boolean => !!a?.monochrome === !!b.monochrome

/** Canister colors as [body, text]: a look's own, else its family's, else its maker's. */
const CANISTERS: Record<string, [string, string]> = {
  aerochrome: ['#7d1838', '#f7b218'],
  monochrome: ['#1c1c1c', '#f2f2ec'],
  kodak: ['#d71f26', '#f7b218'],
  fujifilm: ['#f2f2ec', '#009a49']
}
const canister = (
  stock: Stock,
  aerochrome: boolean
): { color: string; ink: string; text: string } => {
  const look = aerochrome ? 'aerochrome' : stock.monochrome ? 'monochrome' : stock.key.split('_')[0]
  const [color, ink] = CANISTERS[look] ?? ['#d4d4d4', '#262626']
  // The film speed, such as 400 in "Portra 400" or 500T in "Vision3 500T".
  return { color, ink, text: aerochrome ? 'IR' : (stock.name.match(/\d{2,}[A-Z]?/)?.[0] ?? '') }
}

/** The icon of each look group. */
const GROUP_ICONS: Record<string, LucideIcon> = {
  cameraMatching: Camera,
  negativeFilm: Film,
  slideFilm: Projector,
  cinemaFilm: Clapperboard,
  bwFilm: Contrast,
  fullSpectrum: Rainbow
}

interface Look {
  id: string
  name: string
  /** The i18n key suffix of the group, such as `slideFilm`. */
  group?: string
  disabled?: boolean
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
  const keyed = looks
    .filter((look) => !look.disabled)
    .map((look) => ({
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

/** A tooltip on a gallery item. The span takes the hover when the item is disabled. */
function LookTip({
  text,
  focusable,
  children
}: {
  text: string | false
  focusable?: boolean
  children: React.ReactElement
}): React.JSX.Element {
  if (!text) return children
  // A disabled button cannot take focus, so the span does, to reach the tooltip.
  return (
    <Tooltip text={text} side="bottom">
      <span
        className="block self-start rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/60"
        {...(focusable && { tabIndex: 0, role: 'group', 'aria-label': text })}
      >
        {children}
      </span>
    </Tooltip>
  )
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
  const cloud = useContext(DevelopingCloud)
  const asShotGains = useEditorStore((state) => (cloud ? undefined : state.preview?.asShotGains))
  const balance = useEditorStore((state) =>
    !cloud && previewCurrent(state) ? state.preview?.whiteBalance : undefined
  )
  const gains =
    recipe.rawColor?.gains ??
    recipe.whiteBalanceGains ??
    (balance && boundedWhiteBalanceGains(balance.gains)) ??
    asShotGains
  const base = recipe.film ?? DEFAULT_FILM
  const filter = recipe.monochrome?.filter ?? 'neutral'
  const aerochrome =
    !!recipe.rawColor && !!recipe.film && base.film === AEROCHROME_FILM.index && base.negative
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
            group: 'cameraMatching',
            recipe: {
              ...recipe,
              film: null,
              cameraProfile: profile.id,
              rawColor: null,
              monochrome: profile.id === 'Monochrome' ? { filter } : null
            }
          })),
          ...FILMS.map((stock) => ({
            id: stock.key,
            name: stock.name,
            group: family(stock),
            recipe: {
              ...recipe,
              // Film stocks use their own color response, without a camera look.
              cameraProfile: null,
              rawColor: null,
              // Positive film is scanned directly, without a print.
              film: {
                ...base,
                ...(recipe.film && base.film === stock.index
                  ? {}
                  : {
                      ...(!base.halationParams && filmHalationDefaults(stock.index)),
                      ...(base.grainParams && {
                        grainParams: {
                          ...base.grainParams,
                          rmsBase: undefined,
                          rmsGranularity: filmGrainDefaults(stock.index).rmsGranularity
                        }
                      })
                    }),
                film: stock.index,
                paper: paper(stock),
                negative: stock.isPositive
              },
              monochrome: stock.monochrome
                ? { filter: FILM_MONOCHROME_FILTERS.includes(filter) ? filter : 'neutral' }
                : null
            }
          })),
          {
            id: 'full-spectrum',
            name: t('editor.fullSpectrumLook'),
            group: 'fullSpectrum',
            disabled: !gains,
            recipe: {
              ...recipe,
              film: null,
              cameraProfile: null,
              monochrome: null,
              rawColor: gains ? { gains: [...gains], matrix: [...IDENTITY_RAW_MATRIX] } : null
            }
          },
          {
            id: 'aerochrome',
            name: t('editor.aerochrome'),
            group: 'fullSpectrum',
            disabled: !gains,
            recipe: {
              ...recipe,
              cameraProfile: null,
              rawColor: gains ? { gains: [...gains], matrix: [...AEROCHROME_MATRIX] } : null,
              monochrome: null,
              film: {
                ...base,
                ...(recipe.film && base.film === AEROCHROME_FILM.index
                  ? {}
                  : {
                      ...(!base.halationParams && filmHalationDefaults(AEROCHROME_FILM.index)),
                      ...(base.grainParams && {
                        grainParams: {
                          ...base.grainParams,
                          rmsBase: undefined,
                          rmsGranularity: filmGrainDefaults(AEROCHROME_FILM.index).rmsGranularity
                        }
                      })
                    }),
                film: AEROCHROME_FILM.index,
                paper: paper(AEROCHROME_FILM),
                negative: true
              }
            }
          }
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
      : aerochrome
        ? 'aerochrome'
        : recipe.film
          ? FILMS.find((film) => film.index === recipe.film?.film)?.key
          : recipe.rawColor
            ? 'full-spectrum'
            : recipe.monochrome
              ? 'Monochrome'
              : looks.some((look) => look.id === cameraProfile)
                ? cameraProfile
                : 'Standard'
  // The gallery shows one group. It opens on the group of the selected look, else the first.
  const [chosenGroup, setChosenGroup] = useState('')
  const groups = [...new Set(looks.map((look) => look.group))].filter((g): g is string => !!g)
  const shownGroup = groups.includes(chosenGroup)
    ? chosenGroup
    : (looks.find((look) => look.id === selected)?.group ?? groups[0])
  const filters = groups.map((group) => ({
    value: group,
    label: t(`editor.${group}`),
    icon: GROUP_ICONS[group]
  }))
  // Only the shown looks render thumbnails.
  const shown = groups.length ? looks.filter((look) => look.group === shownGroup) : looks
  const [thumbnails, forget] = useThumbnails(gallery ? shown : [])
  const caption = t(
    kind === 'film' ? (gallery ? 'editor.filmStock' : 'editor.look') : 'editor.paperStock'
  )
  const stock = kind === 'film' && FILMS.find((film) => film.index === recipe.film?.film)
  if (gallery)
    return (
      <div role="group" aria-label={caption} className="grid grid-cols-3 gap-x-2 gap-y-3 p-4">
        {/* Two groups of three act as one choice: a value of the other row selects nothing here. */}
        {groups.length > 0 && (
          <div role="group" aria-label={t('editor.filmGroups')} className="col-span-3 space-y-1.5">
            {[filters.slice(0, 3), filters.slice(3)].map((row) => (
              <GlassGroup
                key={row[0].value}
                variant="split"
                display="stacked"
                size="sm"
                aria-label={row.map((item) => item.label).join(', ')}
                value={shownGroup}
                onValueChange={setChosenGroup}
                items={row}
              />
            ))}
          </div>
        )}
        {shown.map((look) => (
          <Fragment key={look.id}>
            <LookTip
              focusable={look.disabled}
              text={
                look.id === 'full-spectrum'
                  ? t('editor.fullSpectrumHelp')
                  : look.id === 'aerochrome' && t('editor.aerochromeHelp')
              }
            >
              <button
                type="button"
                disabled={look.disabled}
                aria-pressed={look.id === selected}
                onClick={(event) => {
                  change({
                    film: look.recipe.film,
                    monochrome: look.recipe.monochrome,
                    cameraProfile: look.recipe.cameraProfile,
                    rawColor: look.recipe.rawColor ?? null
                  })
                  blurOnClick(event)
                }}
                className="group self-start rounded-md text-left font-mono focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="look-thumbnail relative block aspect-[3/2] overflow-hidden rounded-md bg-ink/[0.06] group-hover:ring-1 group-hover:ring-ink/30 group-focus-visible:ring-2 group-focus-visible:ring-ink/60 group-aria-pressed:ring-2 group-aria-pressed:ring-ink">
                  {look.id === 'aerochrome' && (
                    <Info
                      aria-hidden="true"
                      className="absolute right-1 top-1 h-3.5 w-3.5 text-white drop-shadow"
                    />
                  )}
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
                <span className="mt-1 line-clamp-2 block text-[12px] leading-tight text-tone-300 group-aria-pressed:text-ink">
                  {look.name}
                </span>
              </button>
            </LookTip>
          </Fragment>
        ))}
      </div>
    )
  return (
    <div className="relative flex items-center gap-2 rounded-xl border border-ink/15 bg-ink/[0.03] px-3 py-2.5 hover:border-ink/25 has-[:disabled]:opacity-50">
      {stock && <FilmCanister {...canister(stock, aerochrome)} className="-my-1 h-10 shrink-0" />}
      {/* The button's ::after covers the box, so all of it opens the picker. */}
      <button
        type="button"
        data-sidebar-page={kind === 'film' ? 'emulsion' : 'paper'}
        onClick={onOpen}
        className="min-w-0 flex-1 text-left font-mono after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ink/50"
      >
        <span className="control-label block tracking-[0.14em] text-tone-500">{caption}</span>
        <span className="block truncate font-sans text-[13px] text-tone-100">
          {looks.find((look) => look.id === selected)?.name}
        </span>
      </button>
      <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-tone-500" />
    </div>
  )
}
