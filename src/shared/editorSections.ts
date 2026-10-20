import {
  DEFAULT_EFFECTS,
  DEFAULT_FILM,
  DEFAULT_WHEELS,
  filmGrainDefaults,
  filmHalationDefaults,
  type EditRecipe,
  type EffectsSettings,
  type FilmSettings
} from './editor'

/** The monochrome mixer adds `warmth` and `toneMixer`. The type works with and without them. */
type Recipe = EditRecipe & { warmth?: number; toneMixer?: number[] }
type Patch = Partial<Recipe>

/** The settings of an editor panel section. Its menu resets, copies, and pastes them. */
export interface EditorSection {
  /** The section's settings of `from`, as a change to `to`. A paste applies it. */
  take: (from: Recipe, to: Recipe) => Patch
  /** A change that resets the section. Without it, the reset takes the section of `defaults`. */
  reset?: (recipe: Recipe) => Patch
}

/** Film settings of the Effects section. Light changes `evFilm`; Look changes the others. */
const FILM_EFFECTS = [
  'grain',
  'grainParams',
  'grainSize',
  'grainAmount',
  'grainRoughness',
  'grainSaturation',
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

const pick = <T extends object, K extends keyof T>(object: T, keys: readonly K[]): Pick<T, K> =>
  structuredClone(Object.fromEntries(keys.map((key) => [key, object[key]]))) as Pick<T, K>

/** The grain and halation of a recipe, as a look without a film stock keeps them. */
function effectsOf({ film, effects }: Recipe): EffectsSettings {
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
  curves: { take: (from) => pick(from, ['curves']) },
  whiteBalance: { take: (from) => pick(from, ['temperature', 'tint']) },
  detail: { take: (from) => pick(from, ['sharpen', 'denoise', 'denoiseOptions']) },
  look: {
    // The stock, the paper, and the print. The film exposure and the effects stay.
    take: (from, to) => ({
      ...pick(from, ['cameraProfile', 'monochrome', 'film']),
      ...(from.film &&
        to.film && {
          film: { ...structuredClone(from.film), ...pick(to.film, ['evFilm', ...FILM_EFFECTS]) }
        })
    })
  },
  effects: {
    take: (from, to) =>
      to.film
        ? {
            film: {
              ...to.film,
              ...(from.film ? pick(from.film, FILM_EFFECTS) : effectsOf(from))
            }
          }
        : { effects: effectsOf(from) },
    // The defaults of the film stock, or no effects.
    reset: ({ film }) =>
      film
        ? {
            film: {
              ...film,
              ...pick(DEFAULT_FILM, FILM_EFFECTS),
              ...filmHalationDefaults(film.film),
              grainParams: filmGrainDefaults(film.film)
            }
          }
        : { effects: null }
  },
  filter: { take: (from) => ({ monochrome: { filter: from.monochrome?.filter ?? 'neutral' } }) },
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
export function resetSection(section: EditorSection, recipe: Recipe, defaults: Recipe): Patch {
  return section.reset?.(recipe) ?? section.take(defaults, recipe)
}
