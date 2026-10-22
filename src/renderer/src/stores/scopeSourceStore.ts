import { create } from 'zustand'
import type { PreviewRegion } from '@shared/editor'
import type { X3FFileDTO } from '@shared/types'
import type { ScopeSource } from '../components/ScopeSourceControls'
import { geometryKey } from './editorStore'

/** The camera framing. The embedded JPEG shows it, and so does an as-shot render. */
export const AS_SHOT = 'asShot'

/** The framings of the library preview of a file: its saved geometry, else the camera's. */
export const previewFraming = (file: X3FFileDTO): string[] => [
  file.edit ? geometryKey(file.edit.recipe) : AS_SHOT
]

interface Qualified {
  path: string
  /** The framings that show the same pixels as the preview that the area was set on. */
  framing: string[]
  /** 0 to 1 of the cropped, oriented preview. */
  region: PreviewRegion
}

/** The area of a photo in a framing, or null when the area belongs to other pixels. */
export const areaFor = (
  qualified: Qualified | null,
  path: string | undefined,
  framing: string[]
): PreviewRegion | null =>
  qualified && qualified.path === path && qualified.framing.some((item) => framing.includes(item))
    ? qualified.region
    : null

interface ScopeSourceState {
  /** The scope source of the library and the editor. */
  source: ScopeSource
  /** While armed, a click or a drag on the filmstrip preview sets the Qualifier area. */
  qualifying: boolean
  /** The file whose zoomable preview shows in the filmstrip. */
  previewId: string | null
  /** The one Qualifier area of the library and the editor. */
  qualified: Qualified | null
  /** Arm is false for the editor, which arms its own photo. */
  choose: (next: ScopeSource, arm?: boolean) => void
  setPreview: (id: string | null) => void
  qualify: (area: Qualified) => void
  disarm: () => void
}

/** Shares the scope source and the Qualifier area between views and modes. */
export const useScopeSourceStore = create<ScopeSourceState>((set) => ({
  source: 'entire',
  qualifying: false,
  previewId: null,
  qualified: null,
  // Turning the Qualifier on arms it. Turning it off clears its area.
  choose: (source, arm = true) =>
    set((state) => ({
      source,
      qualifying: arm && source === 'qualifier',
      qualified: source === 'qualifier' ? state.qualified : null
    })),
  setPreview: (previewId) => set({ previewId, qualifying: false }),
  qualify: (qualified) => set({ qualified, qualifying: false }),
  disarm: () => set({ qualifying: false })
}))
