export type FitPreviewRequest = {
  id: number
  blob: Blob
  original?: { width: number; height: number }
}

self.onmessage = async (event: MessageEvent<FitPreviewRequest>): Promise<void> => {
  const { id, blob, original } = event.data
  let decoded: ImageBitmap | undefined
  let image: ImageBitmap | undefined
  try {
    // Full embedded JPEGs carry their own EXIF orientation; these are display dimensions.
    decoded = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    const width = original?.width ?? decoded.width
    const height = original?.height ?? decoded.height
    let medium = blob
    if (original) {
      image = decoded
      decoded = undefined
    } else {
      const scale = Math.min(1, 2048 / Math.max(width, height))
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale))
      )
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Offscreen 2D canvas unavailable')
      context.drawImage(decoded, 0, 0, canvas.width, canvas.height)
      decoded.close()
      decoded = undefined
      medium = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
      image = canvas.transferToImageBitmap()
    }
    self.postMessage({ id, image, blob: medium, width, height }, { transfer: [image] })
    image = undefined
  } catch {
    self.postMessage({ id, failed: true })
  } finally {
    decoded?.close()
    image?.close()
  }
}
