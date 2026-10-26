import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

/** Reuse a verified archive, or download and verify it before caching it. */
export async function downloadVerified(url, archivePath, sha256) {
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const cached = await readFile(archivePath).catch(() => null)
  if (cached && hash(cached) === sha256) return

  console.log(`Downloading ${basename(archivePath)}`)
  let bytes
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
      break
    } catch (error) {
      if (attempt === 3) throw new Error(`${basename(archivePath)} download: ${error.message}`)
      console.warn(
        `${basename(archivePath)} download failed (attempt ${attempt}): ${error.message}`
      )
    }
  }
  if (hash(bytes) !== sha256) throw new Error(`${basename(archivePath)} checksum mismatch`)
  await writeFile(archivePath, bytes)
}
