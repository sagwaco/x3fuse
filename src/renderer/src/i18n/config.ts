import { useSyncExternalStore } from 'react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { detectLanguage, type Locale } from '@shared/i18n/detect'
import type { LanguageSetting } from '@shared/types'
import en from '@shared/i18n/locales/en.json'
import es from '@shared/i18n/locales/es.json'
import ja from '@shared/i18n/locales/ja.json'
import ko from '@shared/i18n/locales/ko.json'
import zhHans from '@shared/i18n/locales/zh-Hans.json'
import zhHant from '@shared/i18n/locales/zh-Hant.json'

/**
 * Renderer i18n. The language starts from navigator.language, and the
 * `language` setting changes it in both windows (see applyLanguage).
 * Keys are flat dotted strings (e.g. "queue.empty.title"), so key/ns
 * separators are disabled. Locale JSONs are shared with the main process.
 */
const resources = {
  en: { translation: en },
  es: { translation: es },
  ja: { translation: ja },
  ko: { translation: ko },
  'zh-Hans': { translation: zhHans },
  'zh-Hant': { translation: zhHant }
}

const system: Locale = detectLanguage(typeof navigator !== 'undefined' ? navigator.language : 'en')

void i18n.use(initReactI18next).init({
  resources,
  lng: system,
  fallbackLng: 'en',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false }
})

export const t = (key: string, options?: Record<string, string | number>): string =>
  i18n.t(key, options)

/** Applies the `language` setting. 'auto' uses the system language. */
export function applyLanguage(setting: LanguageSetting): Promise<unknown> {
  const lng = setting === 'auto' ? system : setting
  document.documentElement.lang = lng
  return i18n.changeLanguage(lng)
}

function subscribe(change: () => void): () => void {
  i18n.on('languageChanged', change)
  return () => i18n.off('languageChanged', change)
}

/** Renders the component again when the language changes. */
export const useLanguage = (): string => useSyncExternalStore(subscribe, () => i18n.language)

export default i18n
