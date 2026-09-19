import { describe, it, expect } from 'vitest'
import { detectLanguage, LOCALES } from '@shared/i18n/detect'
import en from '@shared/i18n/locales/en.json'
import ja from '@shared/i18n/locales/ja.json'
import ko from '@shared/i18n/locales/ko.json'
import zhHans from '@shared/i18n/locales/zh-Hans.json'
import zhHant from '@shared/i18n/locales/zh-Hant.json'

const bundles: Record<string, Record<string, string>> = {
  en,
  ja,
  ko,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant
}

describe('detectLanguage', () => {
  it('maps OS/browser tags to supported locales', () => {
    expect(detectLanguage('en-US')).toBe('en')
    expect(detectLanguage('ja')).toBe('ja')
    expect(detectLanguage('ja-JP')).toBe('ja')
    expect(detectLanguage('ko-KR')).toBe('ko')
    expect(detectLanguage('zh-Hans-CN')).toBe('zh-Hans')
    expect(detectLanguage('zh-CN')).toBe('zh-Hans')
    expect(detectLanguage('zh-Hant-TW')).toBe('zh-Hant')
    expect(detectLanguage('zh-TW')).toBe('zh-Hant')
    expect(detectLanguage('zh-HK')).toBe('zh-Hant')
  })

  it('falls back to English for unknown / empty input', () => {
    expect(detectLanguage('fr-FR')).toBe('en')
    expect(detectLanguage('')).toBe('en')
    expect(detectLanguage(undefined)).toBe('en')
    expect(detectLanguage(null)).toBe('en')
  })
})

describe('locale bundles', () => {
  const enKeys = Object.keys(en).sort()

  it('every locale has the same key set as English (no missing/extra keys)', () => {
    for (const lng of LOCALES) {
      expect(Object.keys(bundles[lng]).sort(), `locale ${lng}`).toEqual(enKeys)
    }
  })

  it('has no empty translations', () => {
    for (const lng of LOCALES) {
      for (const [key, value] of Object.entries(bundles[lng])) {
        expect(value.length, `${lng}:${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('carries real translations (spot check)', () => {
    expect(en['button.convert']).toBe('Export')
    expect(ja['button.convert']).toBe('書き出し')
    expect(ko['button.convert']).toBe('내보내기')
    expect(zhHans['button.convert']).toBe('导出')
    expect(zhHant['button.convert']).toBe('匯出')
  })

  it('uses export wording throughout every locale', () => {
    for (const [lng, bundle] of Object.entries(bundles)) {
      for (const [key, value] of Object.entries(bundle)) {
        expect(value, `${lng}:${key}`).not.toMatch(/convert|conversion|変換|변환|转换|轉換/i)
      }
    }
  })
})
