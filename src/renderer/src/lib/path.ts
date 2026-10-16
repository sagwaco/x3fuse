/** Browser-side path helpers (the renderer has no node:path). Cross-platform. */

export function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Name of the containing directory, e.g. ".../Photos/img.X3F" -> "Photos". */
export function parentName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : ''
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}
