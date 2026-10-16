import { create } from 'zustand'

/** The filmstrip publishes its visible area for the Info panel's navigator. */
export interface PreviewMap {
  fileId: string
  aspectRatio: number
  x: number
  y: number
  width: number
  height: number
  panTo: (centerX: number, centerY: number) => void
}

interface PreviewControls {
  fileId: string
  zoom: number | null
  scale: number
  minZoom: number
  maxZoom: number
  zoomTo: (target: number | null | ((scale: number) => number)) => void
}

export const usePreviewStore = create<{
  activeFileId: string | null
  minimap: PreviewMap | null
  controls: PreviewControls | null
}>(() => ({ activeFileId: null, minimap: null, controls: null }))
