import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { detectLanguage, type Locale } from '@shared/i18n/detect'
import en from '@shared/i18n/locales/en.json'
import ja from '@shared/i18n/locales/ja.json'
import ko from '@shared/i18n/locales/ko.json'
import zhHans from '@shared/i18n/locales/zh-Hans.json'
import zhHant from '@shared/i18n/locales/zh-Hant.json'

/**
 * Renderer i18n. Language is detected once from navigator.language (the app
 * doesn't switch at runtime, matching the Swift app) and is the same across both
 * windows. Keys are flat dotted strings (e.g. "queue.empty.title"), so key/ns
 * separators are disabled. Locale JSONs are shared with the main process.
 */
const resources = {
  en: { translation: en },
  ja: { translation: ja },
  ko: { translation: ko },
  'zh-Hans': { translation: zhHans },
  'zh-Hant': { translation: zhHant }
}

const lng: Locale = detectLanguage(
  typeof navigator !== 'undefined' ? navigator.language : 'en'
)

void i18n.use(initReactI18next).init({
  resources,
  lng,
  fallbackLng: 'en',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false }
})

export const t = (key: string): string => i18n.t(key)
export default i18n
