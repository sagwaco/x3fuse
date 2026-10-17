import { describe, expect, it } from 'vitest'
import i18n from '@renderer/i18n/config'
import { detectLanguage, LOCALES } from '@shared/i18n/detect'
import en from '@shared/i18n/locales/en.json'
import es from '@shared/i18n/locales/es.json'

describe('Spanish locale', () => {
  it.each(['es', 'es-ES', 'es-MX', 'ES-ar'])('loads Spanish for %s', async (tag) => {
    expect(LOCALES).toContain('es')
    expect(detectLanguage(tag)).toBe('es')
    const spanish = i18n.cloneInstance({ lng: detectLanguage(tag), forkResourceStore: true })
    await spanish.changeLanguage(detectLanguage(tag))

    expect(spanish.t('button.convert')).toBe('Exportar')
    expect(spanish.t('editor.exposure')).toBe('Exposición')
    expect(spanish.t('filter.count', { shown: 2, total: 5 })).toBe('2 de 5 fotos')
  })

  it('falls back to English when a Spanish key is missing', async () => {
    const spanish = i18n.cloneInstance({ lng: 'es', forkResourceStore: true })
    await spanish.changeLanguage('es')
    const partial: Record<string, string> = { ...es }
    delete partial['editor.exposure']
    spanish.removeResourceBundle('es', 'translation')
    spanish.addResourceBundle('es', 'translation', partial)

    expect(spanish.t('editor.exposure')).toBe(en['editor.exposure'])
    expect(spanish.t('button.convert')).toBe('Exportar')
  })

  it('preserves the English interpolation placeholders', () => {
    for (const [key, text] of Object.entries(en)) {
      const placeholders = (value: string): string[] => value.match(/{{[^}]+}}/g)?.sort() ?? []
      expect(placeholders(es[key as keyof typeof es]), key).toEqual(placeholders(text))
    }
  })
})
