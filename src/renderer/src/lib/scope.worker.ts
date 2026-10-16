import { drawScope, type ScopeRenderRequest } from './scopeRenderer'

self.onmessage = (event: MessageEvent<ScopeRenderRequest & { id: number }>): void => {
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
