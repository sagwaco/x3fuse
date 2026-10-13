import { defaultDenoiseOptions, type DenoiseOptions } from './denoise'

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
export interface FilmSettings {
  film: number
  paper: number
  negative: boolean
  evFilm: number
  evPaper: number | null
  couplers: number
  couplersRadius: number
  grain: boolean
  grainSize: number
  grainAmount: number
  grainSaturation: number
  halation: boolean
  halationStrength: number
  halationRadius: number
  halationMidtones: number
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
export const DEFAULT_FILM: FilmSettings = {
  film: 2,
  paper: 3,
  negative: false,
  evFilm: 0,
  evPaper: null,
  couplers: 0.25,
  couplersRadius: 0.0015,
  grain: true,
  grainSize: 1,
  grainAmount: 1,
  grainSaturation: 1,
  halation: false,
  halationStrength: 0.35,
  halationRadius: 0.0015,
  halationMidtones: 0,
  gammaFilm: 1,
  gammaPaper: 1,
  tuneM: 0,
  tuneY: 0
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
    film: { ...DEFAULT_FILM },
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
