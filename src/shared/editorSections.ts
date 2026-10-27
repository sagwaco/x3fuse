import {
  DEFAULT_DNG_DEMOSAIC,
  DEFAULT_EFFECTS,
  DEFAULT_FILM,
  DEFAULT_WHEELS,
  demosaicsOf,
  FILM_MONOCHROME_FILTERS,
  IDENTITY_RAW_MATRIX,
  MONOCHROME_RAW_MATRIX,
  monochromeRawMatrix,
  filmGrainDefaults,
  filmHalationDefaults,
  hasWhiteBalance,
  monochromeFilm,
  type EditRecipe,
  type EffectsSettings,
  type FilmSettings,
  type MonochromeFilter,
  type SourceCapabilities
} from './editor'

type Patch = Partial<EditRecipe>

/** The settings of an editor panel section. Its menu resets, copies, and pastes them. */
export interface EditorSection {
  /** The section's settings of `from`, as a change to `to`. A paste applies it. */
  take: (from: EditRecipe, to: EditRecipe) => Patch
  /** A change that resets the section. Without it, the reset takes the section of `defaults`. */
  reset?: (recipe: EditRecipe) => Patch
}

/** Film settings of the Grain section. */
const FILM_GRAIN = [
  'grain',
  'grainParams',
  'grainSize',
  'grainAmount',
  'grainRoughness',
  'grainSaturation'
] as const satisfies readonly (keyof FilmSettings)[]

/** Film settings of the Halation section. */
const FILM_HALATION = [
  'halation',
  'halationParams',
  'halationStrength',
  'halationRadius',
  'halationMidtones',
  'scatterSizeRgb',
  'scatterStrengthRgb',
  'halationSizeRgb',
  'halationStrengthRgb'
] as const satisfies readonly (keyof FilmSettings)[]

/** Print settings of the Darkroom section. The profile picks the film and its paper. */
const FILM_DARKROOM = [
  'evPaper',
  'tuneY',
  'tuneM',
  'gammaFilm',
  'gammaPaper',
  'couplers'
] as const satisfies readonly (keyof FilmSettings)[]

const pick = <T extends object, K extends keyof T>(object: T, keys: readonly K[]): Pick<T, K> =>
  structuredClone(Object.fromEntries(keys.map((key) => [key, object[key]]))) as Pick<T, K>

/** The grain and halation of a recipe, as a look without a film stock keeps them. */
function effectsOf({ film, effects }: EditRecipe): EffectsSettings {
  return structuredClone(
    film
      ? {
          grain: film.grain,
          grainParams: film.grainParams ?? DEFAULT_EFFECTS.grainParams,
          halation: film.halation,
          halationParams: film.halationParams ?? DEFAULT_EFFECTS.halationParams
        }
      : { ...DEFAULT_EFFECTS, ...effects }
  )
}

/** The filter, or neutral when the film cannot use it. Black-and-white stocks have no blue filter. */
const allowedFilter = (filter: MonochromeFilter, film: FilmSettings | null): MonochromeFilter =>
  !monochromeFilm(film) || FILM_MONOCHROME_FILTERS.includes(filter) ? filter : 'neutral'

/**
 * Grain or halation, of the film stock or of the profile without one. A reset sets the
 * defaults of the film stock, or of the profile, and keeps the switch of the effect.
 */
function effectSection(effect: 'grain' | 'halation'): EditorSection {
  const filmKeys = effect === 'grain' ? FILM_GRAIN : FILM_HALATION
  const keys =
    effect === 'grain'
      ? (['grain', 'grainParams'] as const)
      : (['halation', 'halationParams'] as const)
  const params = keys[1]
  return {
    take: (from, to) =>
      to.film
        ? {
            film: {
              ...to.film,
              ...(from.film ? pick(from.film, filmKeys) : pick(effectsOf(from), keys))
            }
          }
        : { effects: { ...effectsOf(to), ...pick(effectsOf(from), keys) } },
    reset: (recipe) =>
      recipe.film
        ? {
            film: {
              ...recipe.film,
              ...pick(DEFAULT_FILM, filmKeys),
              ...(effect === 'grain'
                ? { grainParams: filmGrainDefaults(recipe.film.film) }
                : filmHalationDefaults(recipe.film.film)),
              [effect]: recipe.film[effect]
            }
          }
        : { effects: { ...effectsOf(recipe), ...pick(DEFAULT_EFFECTS, [params]) } }
  }
}

/**
 * The editor panel sections by id. A section changes only the settings that its controls
 * change, also inside `film`. The SFD RAW section has no settings to copy.
 */
export const EDITOR_SECTIONS = {
  light: {
    take: (from, to) => ({
      ...pick(from, [
        'exposure',
        'contrast',
        'highlights',
        'shadows',
        'whites',
        'blacks',
        'fillLight'
      ]),
      // A film look shows its own exposure.
      ...(to.film && { film: { ...to.film, evFilm: from.film?.evFilm ?? DEFAULT_FILM.evFilm } })
    })
  },
  curves: { take: (from) => pick(from, ['curves', 'baseCurve']) },
  // A legacy recipe has no demosaic to give. A reset selects the default demosaic.
  demosaic: {
    take: (from) => (from.dngDemosaic ? { dngDemosaic: from.dngDemosaic } : {}),
    reset: () => ({ dngDemosaic: DEFAULT_DNG_DEMOSAIC })
  },
  whiteBalance: {
    take: (from, to) =>
      from.rawColor && to.rawColor
        ? { rawColor: { ...to.rawColor, gains: [...from.rawColor.gains] } }
        : !from.rawColor && !to.rawColor
          ? {
              ...pick(from, ['temperature', 'tint']),
              whiteBalanceGains: from.whiteBalanceGains ? [...from.whiteBalanceGains] : null
            }
          : {}
  },
  channels: {
    take: (from, to) =>
      from.rawColor && to.rawColor
        ? { rawColor: { ...to.rawColor, matrix: [...from.rawColor.matrix] } }
        : {},
    reset: (recipe) =>
      recipe.rawColor
        ? {
            rawColor: {
              ...recipe.rawColor,
              // A monochrome mix stays monochrome.
              matrix: [
                ...(monochromeRawMatrix(recipe.rawColor.matrix)
                  ? MONOCHROME_RAW_MATRIX
                  : IDENTITY_RAW_MATRIX)
              ]
            }
          }
        : {}
  },
  detail: { take: (from) => pick(from, ['sharpen', 'texture', 'clarity', 'denoise', 'denoiseOptions']) },
  darkroom: {
    // A paper prints only film of its own model, black-and-white or color.
    take: (from, to) =>
      from.film && to.film
        ? {
            film: {
              ...to.film,
              ...pick(from.film, FILM_DARKROOM),
              ...(monochromeFilm(from.film) === monochromeFilm(to.film) && {
                paper: from.film.paper
              })
            }
          }
        : {},
    reset: ({ film }) => (film ? { film: { ...film, ...pick(DEFAULT_FILM, FILM_DARKROOM) } } : {})
  },
  grain: effectSection('grain'),
  halation: effectSection('halation'),
  filter: {
    take: (from, to) =>
      to.rawColor
        ? {}
        : { monochrome: { filter: allowedFilter(from.monochrome?.filter ?? 'neutral', to.film) } }
  },
  color: { take: (from) => pick(from, ['saturation', 'vibrance', 'warmth']) },
  toneMixer: { take: (from) => pick(from, ['toneMixer']) },
  colorMixer: { take: (from) => pick(from, ['hsl']) },
  colorWheels: { take: (from) => ({ wheels: structuredClone(from.wheels ?? DEFAULT_WHEELS) }) }
} satisfies Record<string, EditorSection>

export type SectionId = keyof typeof EDITOR_SECTIONS

/** The section with this id, if it has settings. */
export const editorSection = (id: string): EditorSection | undefined =>
  Object.hasOwn(EDITOR_SECTIONS, id) ? EDITOR_SECTIONS[id as SectionId] : undefined

/** A change that resets a section of `recipe`. `defaults` is the photo's as-shot recipe. */
export function resetSection(
  section: EditorSection,
  recipe: EditRecipe,
  defaults: EditRecipe
): Patch {
  return section.reset?.(recipe) ?? section.take(defaults, recipe)
}

/**
 * A paste of a section from a photo with `from` capabilities. White balance gains and raw
 * color belong to one sensor, so they do not go to another sensor. A DNG does not change
 * the Foveon settings of an X3F. The editor removes the settings that the target does not support.
 */
export function pasteSection(
  section: EditorSection,
  id: string,
  source: EditRecipe,
  target: EditRecipe,
  from: SourceCapabilities,
  to: SourceCapabilities
): Patch {
  if (
    id === 'whiteBalance' &&
    (!hasWhiteBalance(from, source) ||
      (from.foveon !== to.foveon && (source.rawColor || source.whiteBalanceGains)))
  )
    return {}
  const patch = section.take(source, target)
  // A monochrome DNG keeps its demosaic when the source method is for a Bayer DNG only.
  if (patch.dngDemosaic && !demosaicsOf(to).includes(patch.dngDemosaic)) delete patch.dngDemosaic
  if (!from.foveon && to.foveon) {
    delete patch.fillLight
    delete patch.denoise
    delete patch.denoiseOptions
  }
  return patch
}
