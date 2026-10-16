/** Sensor-space controls shared by export settings and nondestructive recipes. */
export interface DenoiseOptions {
  algorithm: 'nlm' | 'bm3d'
  luminance: boolean
  chroma: boolean
  strength: number
  nlm: {
    lumaPatch: number
    chromaPatch: number
    lumaSearch: number
    chromaSearch: number
  }
}

export function defaultDenoiseOptions(): DenoiseOptions {
  return {
    algorithm: 'nlm',
    luminance: false,
    chroma: true,
    strength: 1,
    nlm: { lumaPatch: 3, chromaPatch: 3, lumaSearch: 11, chromaSearch: 11 }
  }
}
