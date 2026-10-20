import type { Config } from 'tailwindcss'
import { fontFamily } from 'tailwindcss/defaultTheme'

const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`
type Family = [string[], { fontFeatureSettings: string; fontVariationSettings: string }]
// Kode Mono is bundled; see the @font-face rule in index.css. Titles and headings use it.
const kodeMono: Family = [
  ['Kode Mono', ...fontFamily.mono],
  {
    fontFeatureSettings: "'calt' 1, 'ss01' 1, 'ss02' 1",
    fontVariationSettings: "'wght' 500, 'wdth' 87.5, 'ROND' 100"
  }
]
// All other text uses the system font. The reset stops the Kode Mono axes from changing it.
const system: Family = [
  ['system-ui', '-apple-system', "'Segoe UI'", 'Roboto', "'Helvetica Neue'", 'Arial', 'sans-serif'],
  { fontFeatureSettings: 'normal', fontVariationSettings: 'normal' }
]

export default {
  content: ['./index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Contrast steps from the surface: tone-950 is the window, tone-100 is text, in every theme.
        tone: Object.fromEntries(steps.map((n) => [n, token(`tone-${n}`)])),
        ink: token('ink'),
        accent: token('accent'),
        danger: token('danger'),
        success: token('success'),
        warning: token('warning')
      },
      fontFamily: { sans: system, mono: kodeMono }
    }
  },
  plugins: []
} satisfies Config
