import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Image } from '@tauri-apps/api/image'
import type { LucideIcon } from 'lucide-react'
import { useSettingsStore } from '../stores/settingsStore'
import { isNativeDark } from './theme'

// A 16 pt menu icon drawn at 2x.
const SIZE = 32
const DISABLED_ALPHA = 0.35

/** Draws a Lucide icon in the menu text color as a raw RGBA image. No PNG feature is needed. */
export function menuIcon(icon: LucideIcon, disabled: boolean): Promise<Image> {
  const { appearanceMode } = useSettingsStore.getState().settings
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  return draw(icon, menuIconColor(isNativeDark({ appearanceMode }, systemDark)), disabled)
}

/** The native menu text color: it follows the window appearance, not the CSS theme. */
export function menuIconColor(dark: boolean): string {
  return dark ? '#f2f2f2' : '#1d1d1f'
}

async function draw(icon: LucideIcon, color: string, disabled: boolean): Promise<Image> {
  const host = document.createElement('div')
  const root = createRoot(host)
  flushSync(() =>
    root.render(createElement(icon, { size: SIZE, color: '#000', strokeWidth: 1.75 }))
  )
  const svg = host.innerHTML
  root.unmount()
  const source = new window.Image()
  source.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await source.decode()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SIZE
  const context = canvas.getContext('2d')!
  context.drawImage(source, 0, 0, SIZE, SIZE)
  // Paint the menu color over the black strokes.
  context.globalCompositeOperation = 'source-in'
  context.globalAlpha = disabled ? DISABLED_ALPHA : 1
  context.fillStyle = color
  context.fillRect(0, 0, SIZE, SIZE)
  const { data } = context.getImageData(0, 0, SIZE, SIZE)
  return Image.new(new Uint8Array(data.buffer), SIZE, SIZE)
}
