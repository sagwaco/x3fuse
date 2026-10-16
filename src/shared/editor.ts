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
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  /** SIGMA Photo Pro's X3 Fill Light, -2..2 in steps of 0.1. */
  fillLight: number
  saturation: number
  vibrance: number
  curves: Record<'master' | 'red' | 'green' | 'blue', CurvePoint[]>
  hsl: HslBand[]
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
  monochrome: { filter: MonochromeFilter } | null
  seed: number
}
/** A negative film scanned without a print shows as a negative. */
export const negativePrint = (film: FilmSettings | null): boolean =>
  !!film?.negative &&
  !stocks.find((stock) => !stock.isPaper && stock.index === film.film)?.isPositive
export const DEFAULT_FILM: FilmSettings = {
  film: 2,
  paper: 3,
  negative: false,
  evFilm: 0,
  evPaper: null,
  couplers: 0.25,
  couplersRadius: 0.0015,
  grain: true,
  grainParams: { rmsGranularity: [4.5, 4.5, 4.5], blur: 0.89, multUsmAmount: 1.5 },
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
/** RMS values from the bundled Spektrafilm grain presets. */
export function filmGrainDefaults(film: number): GrainParams {
  const stock = stocks.find((item) => !item.isPaper && item.index === film)
  const rms = (grainRms as Record<string, number[]>)[stock?.key ?? ''] ?? [6, 8, 10]
  return { rmsGranularity: [...rms] as Rgb, blur: 0.89, multUsmAmount: 1.5 }
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
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    fillLight: 0,
    saturation: 0,
    vibrance: 0,
    curves: { master: line(), red: line(), green: line(), blue: line() },
    hsl: Array.from({ length: 8 }, () => ({ hue: 0, saturation: 0, luminance: 0 })),
    denoise: 10,
    denoiseOptions: defaultDenoiseOptions(),
    sharpen: 0,
    crop: null,
    rotation: 0,
    straighten: 0,
    pitch: 0,
    yaw: 0,
    film: structuredClone(DEFAULT_FILM),
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
    seed: target.seed
  }
}

export interface PreviewRegion {
  x: number
  y: number
  width: number
  height: number
}
