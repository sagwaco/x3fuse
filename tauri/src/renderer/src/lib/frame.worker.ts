export type FrameRequest = {
  id: number
  buffer: ArrayBuffer
  byteOffset: number
  width: number
  height: number
}

// Makes bitmaps from raw RGBA8 frames, so the copy does not delay animation
// frames on the main thread.
self.onmessage = async ({ data }: MessageEvent<FrameRequest>): Promise<void> => {
  const { id, buffer, byteOffset, width, height } = data
  try {
    const pixels = new Uint8ClampedArray(buffer, byteOffset, width * height * 4)
    const image = await createImageBitmap(new ImageData(pixels, width, height))
    self.postMessage({ id, image }, { transfer: [image] })
  } catch {
    self.postMessage({ id })
  }
}
