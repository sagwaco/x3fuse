/**
 * Convert the Swift app's Localizable.strings files into flat JSON locale
 * bundles used by the Electron app's i18n (src/shared/i18n/locales/<lng>.json).
 *
 * One-time/dev tool: re-run whenever the Swift .strings change.
 *   node scripts/strings-to-json.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const electronRoot = join(here, '..')
const swiftRoot = join(electronRoot, '..', 'X3Fuse')
const outDir = join(electronRoot, 'src', 'shared', 'i18n', 'locales')

// Swift .lproj directory -> our locale code.
const LOCALES = {
  Base: 'en',
  ja: 'ja',
  ko: 'ko',
  'zh-Hans': 'zh-Hans',
  'zh-Hant': 'zh-Hant'
}

// Matches:  "key" = "value";   (value may contain escaped quotes/backslashes)
const LINE_RE = /^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/

function unescape(s) {
  return s.replace(/\\(["\\])/g, '$1')
}

function parseStrings(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line)
    if (m) out[unescape(m[1])] = unescape(m[2])
  }
  return out
}

mkdirSync(outDir, { recursive: true })

for (const [lproj, lng] of Object.entries(LOCALES)) {
  const src = join(swiftRoot, `${lproj}.lproj`, 'Localizable.strings')
  const dict = parseStrings(readFileSync(src, 'utf8'))
  const dest = join(outDir, `${lng}.json`)
  writeFileSync(dest, JSON.stringify(dict, null, 2) + '\n', 'utf8')
  console.log(`${lng}: ${Object.keys(dict).length} keys -> ${dest}`)
}
