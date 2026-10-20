import { expect, it } from 'vitest'
import { isNativeDark } from '../src/renderer/src/lib/theme'
import { menuIconColor } from '../src/renderer/src/lib/menuIcon'

// The CSS theme surface must not matter: only the window appearance does.
it('picks the icon color from the window appearance, with the system in Auto', () => {
  // A Dark appearance with a Light theme surface still has a dark native menu.
  expect(menuIconColor(isNativeDark({ appearanceMode: 'dark' }, false))).toBe('#f2f2f2')
  // A Light appearance with a Dark theme surface still has a light native menu.
  expect(menuIconColor(isNativeDark({ appearanceMode: 'light' }, true))).toBe('#1d1d1f')
  expect(isNativeDark({ appearanceMode: 'auto' }, true)).toBe(true)
  expect(isNativeDark({ appearanceMode: 'auto' }, false)).toBe(false)
})
