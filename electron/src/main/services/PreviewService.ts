import { stat } from 'fs/promises'
import type { PreviewVariant } from '@shared/preview'
import type { BinaryResolver } from './BinaryResolver'
import { spawnCaptureBinary } from './ProcessRunner'
import { logger } from './Logger'

const TAG_CHAIN: Record<PreviewVariant, string[]> = {
  preview: ['PreviewImage', 'ThumbnailImage', 'JpgFromRaw'],
  full: ['JpgFromRaw', 'PreviewImage']
}

/** Keep at most this many bytes of extracted JPEGs in memory (full-res ~9MB each). */
const CACHE_BUDGET_BYTES = 128 * 1024 * 1024

function isJpeg(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8
}

interface CacheEntry {
  key: string
  bytes: Buffer
}

/**
 * Extracts embedded JPEG previews from X3F files via exiftool and caches the
 * bytes in a byte-budgeted LRU. Bytes are served to the renderer through the
 * `x3f-preview://` custom protocol (see main/previewProtocol.ts), not over IPC,
 * so thumbnails benefit from the browser's lazy `<img>` decoding and caching.
 */
export class PreviewService {
  /** Insertion-ordered map = LRU; re-set on hit to move to the end. */
  private readonly cache = new Map<string, CacheEntry>()
  private cachedBytes = 0

  constructor(private readonly resolver: BinaryResolver) {}

  /**
   * Returns the JPEG bytes for `path`/`variant`, or null when the file has no
   * usable embedded image. Cached by path + mtime + variant.
   */
  async getJpeg(path: string, variant: PreviewVariant): Promise<Buffer | null> {
    let mtimeMs = 0
    try {
      mtimeMs = (await stat(path)).mtimeMs
    } catch {
      return null
    }
    const key = `${variant}:${mtimeMs}:${path}`

    const hit = this.cache.get(key)
    if (hit) {
      // Move to most-recently-used.
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit.bytes
    }

    const bytes = await this.extract(path, variant)
    if (bytes) this.store(key, bytes)
    return bytes
  }

  private async extract(path: string, variant: PreviewVariant): Promise<Buffer | null> {
    const { command, prefixArgs } = this.resolver.exiftool()
    for (const tag of TAG_CHAIN[variant]) {
      const args = [...prefixArgs, '-b', `-${tag}`, path]
      try {
        const { result } = spawnCaptureBinary(command, args)
        const { code, stdout } = await result
        if (code === 0 && isJpeg(stdout)) return stdout
      } catch (e) {
        logger.debug(`preview extract ${tag} failed for ${path}: ${String(e)}`)
      }
    }
    return null
  }

  private store(key: string, bytes: Buffer): void {
    this.cache.set(key, { key, bytes })
    this.cachedBytes += bytes.length
    // Evict least-recently-used until back under budget.
    while (this.cachedBytes > CACHE_BUDGET_BYTES && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value as string
      const evicted = this.cache.get(oldest)
      this.cache.delete(oldest)
      if (evicted) this.cachedBytes -= evicted.bytes.length
    }
  }
}
