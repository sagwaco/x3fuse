import { create } from 'zustand'
import type { PreviewRegion } from '@shared/editor'
import type { ScopeSource } from '../components/ScopeSourceControls'

interface ScopeSourceState {
  source: ScopeSource
  /** While armed, a click or a drag on the filmstrip preview sets the Qualifier area. */
  qualifying: boolean
  /** The file whose zoomable preview shows in the filmstrip. */
  previewId: string | null
  /** The visible part and the qualified area, 0 to 1 of the oriented preview of one file. */
  viewport: { id: string; region: PreviewRegion | null } | null
  qualified: { id: string; region: PreviewRegion } | null
  choose: (next: ScopeSource) => void
  setPreview: (id: string | null) => void
  setViewport: (id: string, region: PreviewRegion | null) => void
  qualify: (id: string, region: PreviewRegion) => void
  disarm: () => void
}

/** Shares the queue scope source between the inspector and the filmstrip preview. */
export const useScopeSourceStore = create<ScopeSourceState>((set) => ({
  source: 'entire',
  qualifying: false,
  previewId: null,
  viewport: null,
  qualified: null,
  // Choosing the Qualifier arms it again, so a new area can replace the last one.
  choose: (source) =>
    set((state) => ({
      source,
      qualifying: source === 'qualifier',
      qualified: source === 'qualifier' ? state.qualified : null
    })),
  setPreview: (previewId) => set({ previewId, qualifying: false, qualified: null }),
  setViewport: (id, region) => set({ viewport: { id, region } }),
  qualify: (id, region) => set({ qualified: { id, region }, qualifying: false }),
  disarm: () => set({ qualifying: false })
}))
