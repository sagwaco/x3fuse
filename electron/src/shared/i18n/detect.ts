/** Supported UI locales (match the Swift app's .lproj set). */
export const LOCALES = ['en', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const
export type Locale = (typeof LOCALES)[number]

/**
 * Map an OS/browser language tag to a supported locale. Used by both processes:
 * the renderer passes navigator.language, main passes app.getLocale().
 */
export function detectLanguage(input: string | undefined | null): Locale {
  const tag = (input ?? '').toLowerCase()
  if (tag.startsWith('ja')) return 'ja'
  if (tag.startsWith('ko')) return 'ko'
  if (tag.startsWith('zh')) {
    // Traditional Chinese variants.
    if (
      tag.includes('hant') ||
      tag.includes('tw') ||
      tag.includes('hk') ||
      tag.includes('mo')
    ) {
      return 'zh-Hant'
    }
    return 'zh-Hans'
  }
  return 'en'
}
