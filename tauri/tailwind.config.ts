import type { Config } from 'tailwindcss'

const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`

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
      }
    }
  },
  plugins: []
} satisfies Config
