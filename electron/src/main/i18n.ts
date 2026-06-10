import { app } from 'electron'
import { detectLanguage, type Locale } from '@shared/i18n/detect'
import en from '@shared/i18n/locales/en.json'
import ja from '@shared/i18n/locales/ja.json'
import ko from '@shared/i18n/locales/ko.json'
import zhHans from '@shared/i18n/locales/zh-Hans.json'
import zhHant from '@shared/i18n/locales/zh-Hant.json'

/**
 * Lightweight main-process translator so the native menu and dialogs are
 * localized too (full parity). Shares the locale JSONs with the renderer; the
 * language comes from app.getLocale(). A dependency-free lookup is enough since
 * the language is fixed per session.
 */
export type Translate = (key: string) => string

const BUNDLES: Record<Locale, Record<string, string>> = {
  en,
  ja,
  ko,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant
}

export function createTranslator(): Translate {
  const dict = BUNDLES[detectLanguage(app.getLocale())]
  return (key) => dict[key] ?? en[key as keyof typeof en] ?? key
}
