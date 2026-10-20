import fontUrl from '../assets/fonts/KodeMono-Variable.woff2?url'
import { drawScope, type ScopeRenderRequest } from './scopeRenderer'

// A worker does not get the document fonts. Load Kode Mono for the scope labels.
const font = new FontFace('Kode Mono', `url(${fontUrl})`, {
  weight: '400 700',
  stretch: '75% 125%',
  featureSettings: "'calt' 1, 'ss01' 1, 'ss02' 1"
})
;(self as unknown as FontFaceSource).fonts.add(font)
const fontLoaded = font.load().catch(() => undefined)

self.onmessage = async (
  event: MessageEvent<ScopeRenderRequest & { id: number }>
): Promise<void> => {
  await fontLoaded
  const request = event.data
  try {
    const canvas = new OffscreenCanvas(
      Math.round(request.width * request.pixelRatio),
      Math.round(200 * request.pixelRatio)
    )
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Offscreen 2D canvas unavailable')
    const steps = drawScope(context, request)
    while (!steps.next().done) {
      // The worker drains the same chunks the compatibility path yields between.
    }
    const bitmap = canvas.transferToImageBitmap()
    self.postMessage({ id: request.id, bitmap }, { transfer: [bitmap] })
  } catch {
    self.postMessage({ id: request.id, failed: true })
  }
}
