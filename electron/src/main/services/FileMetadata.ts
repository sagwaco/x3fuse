import { open, stat } from 'fs/promises'

export interface BasicMetadata {
  /** Source file size in bytes. */
  fileSize: number
  /** ISO-8601 capture timestamp, or undefined if none could be determined. */
  capturedDate?: string
}

const HEADER_BYTES = 65536
// X3F files embed EXIF DateTime as ASCII "YYYY:MM:DD HH:MM:SS".
const DATETIME_RE = /(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/

/**
 * Read basic metadata for a queued file (port of
 * ConversionQueue.extractBasicFileMetadata + extractCaptureDate): file size,
 * plus a best-effort capture date scanned from the first 64KB of the X3F
 * header, falling back to the filesystem creation/modification time.
 */
export async function readBasicMetadata(filePath: string): Promise<BasicMetadata> {
  const s = await stat(filePath)
  const fromHeader = await extractCaptureDate(filePath)
  const capturedDate = fromHeader ?? filesystemDate(s.birthtime, s.mtime)
  return { fileSize: s.size, capturedDate }
}

async function extractCaptureDate(filePath: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    return undefined
  }
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
    // latin1 keeps every byte as a code point so the ASCII date survives.
    const text = buffer.subarray(0, bytesRead).toString('latin1')
    const m = DATETIME_RE.exec(text)
    if (!m) return undefined
    const [, y, mo, d, h, mi, sec] = m
    const date = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(sec)
    )
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
  } finally {
    await handle.close()
  }
}

function filesystemDate(birthtime: Date, mtime: Date): string | undefined {
  const creation = birthtime.getTime()
  if (creation > 0 && !Number.isNaN(creation)) return birthtime.toISOString()
  const modified = mtime.getTime()
  if (modified > 0 && !Number.isNaN(modified)) return mtime.toISOString()
  return undefined
}
