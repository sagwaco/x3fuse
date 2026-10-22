import { defaultDenoiseOptions, type DenoiseOptions } from './denoise'
import stocks from './film-stocks.json'
import grainRms from './film-grain.json'

/** Versioned, non-destructive adjustments shared with x3f-core's GPU renderer. */
export interface CurvePoint {
  x: number
  y: number
}
export interface HslBand {
  hue: number
  saturation: number
  luminance: number
}
/** One color wheel. `x`, `y` is the dot in the unit disc, with `y` up. Its angle is the
    hue (red at 0°, green at 120°, blue at 240°) and its length the strength. */
export interface Wheel {
  x: number
  y: number
  /** The zone's brightness, -100..100. */
  luminance: number
  /** The hue (radians) that the wheel keeps at zero strength. Missing means 0. */
  hue?: number
}
/** Three-way color grading. Blending (0..100) softens the zone borders; Balance
    (-100..100) moves them, with negative values widening the shadows. */
export interface ColorWheels {
  shadows: Wheel
  midtones: Wheel
  highlights: Wheel
  blending: number
  balance: number
}
export const DEFAULT_WHEELS: ColorWheels = {
  shadows: { x: 0, y: 0, luminance: 0 },
  midtones: { x: 0, y: 0, luminance: 0 },
  highlights: { x: 0, y: 0, luminance: 0 },
  blending: 50,
  balance: 0
}
export type Rgb = [number, number, number]
export interface GrainParams {
  rmsGranularity: Rgb
  /** Main slider value. The renderer uses the absolute channel values. */
  rmsBase?: number
  blur: number
  multUsmAmount: number
}
export interface HalationParams {
  scatterAmount: number
  scatterSpatialScale: number
  halationAmount: number
  halationSpatialScale: number
}
/** Grain and halation for a look without a film stock, such as a camera matching profile.
    A film stock keeps its own grain and halation in `FilmSettings`. */
export interface EffectsSettings {
  grain: boolean
  grainParams: GrainParams
  halation: boolean
  halationParams: HalationParams
}
export interface FilmSettings {
  film: number
  paper: number
  negative: boolean
  evFilm: number
  evPaper: number | null
  couplers: number
  couplersRadius: number
  grain: boolean
  /** Missing parameters keep the previous rendering until the effect is reset. */
  grainParams?: GrainParams | null
  grainSize: number
  grainAmount: number
  grainRoughness: number
  grainSaturation: number
  halation: boolean
  halationParams?: HalationParams | null
  halationStrength: number
  halationRadius: number
  halationMidtones: number
  /** Per-channel (RGB) settings from spektrafilm, in micrometers.
      Scatter size is an exponential decay length; halation size is a Gaussian sigma.
      Scatter strength is the fraction of the scattered light in the
      wide tail; halation strength is the fraction of light that halates.
      Used only by recipes without halationParams. B&W film uses the first channel. */
  scatterSizeRgb: Rgb
  scatterStrengthRgb: Rgb
  halationSizeRgb: Rgb
  halationStrengthRgb: Rgb
  gammaFilm: number
  gammaPaper: number
  tuneM: number
  tuneY: number
}
export const MONOCHROME_FILTERS = ['neutral', 'red', 'orange', 'yellow', 'green', 'blue'] as const
export type MonochromeFilter = (typeof MONOCHROME_FILTERS)[number]
/** Taking filters with measured data for black-and-white film stocks. There is no blue filter. */
export const FILM_MONOCHROME_FILTERS: readonly MonochromeFilter[] = [
  'neutral',
  'yellow',
  'orange',
  'red',
  'green'
]
export interface EditRecipe {
  version: 1
  /** CAMF picture mode. Missing or null keeps the legacy color transform. */
  cameraProfile?: string | null
  exposure: number
  temperature: number | null
  tint: number
  /** Direct layer gains for calibrated white balance. Missing or null uses temperature and tint. */
  whiteBalanceGains?: Rgb | null
  /** Full spectrum raw color. It replaces white balance and the camera color matrix.
      Missing or null keeps the calibrated visible path. */
  rawColor?: RawColor | null
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  /** SIGMA Photo Pro's X3 Fill Light, -2..2 in steps of 0.1. */
  fillLight: number
  saturation: number
  vibrance: number
  /** Monochrome warmth and tone bands, -100..100. Missing values mean zero. */
  warmth?: number
  toneMixer?: number[]
  curves: Record<'master' | 'red' | 'green' | 'blue', CurvePoint[]>
  hsl: HslBand[]
  /** Missing means `DEFAULT_WHEELS`. The renderer does not write the default. */
  wheels?: ColorWheels
  denoise: number
  denoiseOptions: DenoiseOptions
  sharpen: number
  crop: { x: number; y: number; width: number; height: number } | null
  rotation: number
  straighten: number
  /** Perspective as a virtual camera turn in degrees; see lib/perspective.ts. */
  pitch: number
  yaw: number
  film: FilmSettings | null
  /** Used only while `film` is null. Missing or null renders without grain or halation. */
  effects?: EffectsSettings | null
  monochrome: { filter: MonochromeFilter } | null
  seed: number
  /** The frames of an X3I. Absent means the middle exposure, the unfused RAW.
      X3F files ignore it. */
  x3iSource?: X3iSource
}
/** Gains on the bottom, middle, and top sensor layers, then a row-major 3x3 mix to RGB.
    Rows are output red, green, and blue. The renderer divides the gains by the middle gain. */
export interface RawColor {
  gains: [number, number, number]
  matrix: number[]
}
export const IDENTITY_RAW_MATRIX: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
export const RAW_GAIN_RANGE = [1 / 64, 64] as const
/** A common scale preserves white balance while fitting the stored gain range. */
export function boundedWhiteBalanceGains(gains: Rgb): Rgb | undefined {
  if (gains.some((gain) => !Number.isFinite(gain) || gain <= 0)) return
  const lower = Math.max(...gains.map((gain) => RAW_GAIN_RANGE[0] / gain))
  const upper = Math.min(...gains.map((gain) => RAW_GAIN_RANGE[1] / gain))
  if (lower > upper) return
  const scale = Math.max(lower, Math.min(upper, 1))
  return gains.map((gain) =>
    Math.max(RAW_GAIN_RANGE[0], Math.min(RAW_GAIN_RANGE[1], gain * scale))
  ) as Rgb
}
/** Empirical DP2 Merrill mix for a 550/660/850 nm filter, not measured band separation. */
export const AEROCHROME_MATRIX: number[] = [1.7, 0, -0.7, -1, 3, -1, 0.5, -3.5, 4]
/** The frames of an X3I (Super Fine Detail) photo: all merged, or the middle exposure only. */
export type X3iSource = 'merge' | 'middle_exposure'
/** True when an X3I uses its SFD RAW, the merge of all its frames. */
export const usesSfd = (recipe: EditRecipe | undefined): boolean => recipe?.x3iSource === 'merge'
/** A negative film scanned without a print shows as a negative. */
export const negativePrint = (film: FilmSettings | null): boolean =>
  !!film?.negative &&
  !stocks.find((stock) => !stock.isPaper && stock.index === film.film)?.isPositive
/** True when the film stock is black-and-white. */
export const monochromeFilm = (film: FilmSettings | null): boolean =>
  !!stocks.find((stock) => !stock.isPaper && stock.index === film?.film)?.monochrome
export const DEFAULT_FILM: FilmSettings = {
  film: 2,
  paper: 3,
  negative: false,
  evFilm: 0,
  evPaper: null,
  couplers: 0.25,
  couplersRadius: 0.0015,
  grain: true,
  grainParams: { rmsGranularity: [4.5, 4.5, 4.5], blur: 0.7, multUsmAmount: 1.5 },
  grainSize: 1,
  grainAmount: 1,
  grainRoughness: 0,
  grainSaturation: 1,
  halation: false,
  halationParams: {
    scatterAmount: 1,
    scatterSpatialScale: 1,
    halationAmount: 1,
    halationSpatialScale: 1
  },
  halationStrength: 0.35,
  halationRadius: 0.0015,
  halationMidtones: 0,
  scatterSizeRgb: [9.3, 9.7, 9.1],
  scatterStrengthRgb: [0.78, 0.65, 0.67],
  halationSizeRgb: [65, 65, 65],
  halationStrengthRgb: [0.015, 0.005, 0],
  gammaFilm: 1,
  gammaPaper: 1,
  tuneM: 0,
  tuneY: 0
}
/** Set the stock's physical halation defaults when selecting a new film. */
export function filmHalationDefaults(
  film: number
): Pick<FilmSettings, 'halationSizeRgb' | 'halationStrengthRgb'> {
  const stock = stocks.find((item) => !item.isPaper && item.index === film)
  const size = stock?.use === 'cine' ? 50 : 65
  const strength: Rgb =
    stock?.antihalation === 'no'
      ? [0.3, 0.1, 0.015]
      : stock?.antihalation === 'weak'
        ? [0.08, 0.02, 0]
        : [0.015, 0.005, 0]
  return { halationSizeRgb: [size, size, size], halationStrengthRgb: strength }
}
/** Generic effects for a look without a film stock: spektrafilm's schema-default grain, no halation. */
export const DEFAULT_EFFECTS: EffectsSettings = {
  grain: false,
  grainParams: { rmsGranularity: [6, 8, 10], blur: 0.7, multUsmAmount: 1.5 },
  halation: false,
  halationParams: { ...DEFAULT_FILM.halationParams! }
}
/** RMS values from the bundled Spektrafilm grain presets. */
export function filmGrainDefaults(film: number): GrainParams {
  const stock = stocks.find((item) => !item.isPaper && item.index === film)
  const rms = (grainRms as Record<string, number[]>)[stock?.key ?? ''] ?? [6, 8, 10]
  return { rmsGranularity: [...rms] as Rgb, blur: 0.7, multUsmAmount: 1.5 }
}
export function grainRmsBase(grain: GrainParams, monochrome = false): number {
  return (
    grain.rmsBase ??
    (monochrome
      ? grain.rmsGranularity[0]
      : grain.rmsGranularity.reduce((sum, value) => sum + value, 0) / 3)
  )
}
export function defaultRecipe(): EditRecipe {
  const line = (): CurvePoint[] => [
    { x: 0, y: 0 },
    { x: 1, y: 1 }
  ]
  return {
    version: 1,
    cameraProfile: null,
    exposure: 0,
    temperature: null,
    tint: 0,
    whiteBalanceGains: null,
    rawColor: null,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    fillLight: 0,
    saturation: 0,
    vibrance: 0,
    warmth: 0,
    toneMixer: Array(8).fill(0),
    curves: { master: line(), red: line(), green: line(), blue: line() },
    hsl: Array.from({ length: 8 }, () => ({ hue: 0, saturation: 0, luminance: 0 })),
    // Present so Reset clears the wheels.
    wheels: structuredClone(DEFAULT_WHEELS),
    denoise: 10,
    denoiseOptions: defaultDenoiseOptions(),
    sharpen: 0,
    crop: null,
    rotation: 0,
    straighten: 0,
    pitch: 0,
    yaw: 0,
    film: structuredClone(DEFAULT_FILM),
    // Written as null so Reset clears the generic effects of a camera look.
    effects: null,
    monochrome: null,
    seed: 0
  }
}
export interface EditRecord {
  recipe: EditRecipe
  revision: number
  storage?: 'sidecar' | 'backup' | 'none'
  storagePath?: string
  previewUrl?: string
  sourceRevision?: string
  /** False when the saved recipe is the photo's defaults, as after Reset or Undo. */
  edited?: boolean
}
export interface EditorSession extends EditRecord {
  sessionId: string
  path: string
  /** Camera framing inside the EXIF-oriented active image. */
  asShotCrop?: EditRecipe['crop']
  cameraProfiles?: Array<{ id: string; name: string }>
  asShotCameraProfile?: string | null
  width?: number
  height?: number
  stocks?: Array<{ id: string; name: string }>
  /** For an X3I photo: the editor renders it only after its frames merge. */
  x3i?: X3iStatus
}
/** The merge state of an X3I (Super Fine Detail) photo. */
export interface X3iStatus {
  frames: number
  /** The merged image is cached, so the photo renders. */
  processed: boolean
  /** The file name and size of the cached merged image. */
  name?: string
  bytes?: number
  /** 0 to 1 while a merge runs. */
  progress?: number
  /** Why the last merge failed. A cancelled merge has no error. */
  error?: string
}
export interface WhiteBalanceValues {
  temperature: number
  tint: number
  gains: Rgb
}
export function usesExtendedWhiteBalance(recipe: EditRecipe): boolean {
  return (
    !!recipe.rawColor ||
    !!recipe.whiteBalanceGains ||
    (recipe.temperature !== null && (recipe.temperature < 2000 || recipe.temperature > 12000)) ||
    Math.abs(recipe.tint) > 100
  )
}
export interface RenderedPreview {
  sessionId: string
  revision: number
  url: string
  width: number
  height: number
  fullWidth?: number
  fullHeight?: number
  sourceWidth?: number
  sourceHeight?: number
  region?: PreviewRegion | null
  /** Temporary denoise quality; the saved recipe is applied by idle refinement. */
  draft?: boolean
  /** Slider values equivalent to the camera's white balance (temperature: null). */
  asShotTemperature?: number
  asShotTint?: number
  /** Raw color layer gains for the camera's white balance, relative to the middle layer. */
  asShotGains?: [number, number, number]
  /** Current balance in both calibrated and direct gain coordinates. */
  whiteBalance?: WhiteBalanceValues
}

/** The recipe without the hue that a wheel keeps at zero strength: it changes no pixels. */
export function pixelRecipe(recipe: EditRecipe): EditRecipe {
  if (!recipe.wheels) return recipe
  const strip = ({ hue: _hue, ...wheel }: Wheel): Wheel => wheel
  const { shadows, midtones, highlights } = recipe.wheels
  return {
    ...recipe,
    wheels: {
      ...recipe.wheels,
      shadows: strip(shadows),
      midtones: strip(midtones),
      highlights: strip(highlights)
    }
  }
}

/** Geometry and the per-photo stochastic seed never travel with adjustments. */
export function pasteRecipe(source: EditRecipe, target: EditRecipe): EditRecipe {
  return {
    ...structuredClone(source),
    crop: target.crop,
    rotation: target.rotation,
    straighten: target.straighten,
    pitch: target.pitch,
    yaw: target.yaw,
    seed: target.seed,
    x3iSource: target.x3iSource
  }
}

export interface PreviewRegion {
  x: number
  y: number
  width: number
  height: number
}
