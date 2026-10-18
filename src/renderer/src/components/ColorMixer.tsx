import { useState } from 'react'
import type { EditRecipe } from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { Adjustment } from './EditorControls'

const hsl = (hue: number, saturation = 75, lightness = 55): string =>
  `hsl(${hue} ${saturation}% ${lightness}%)`

/** Color mixer bands, in the renderer's order, by hue in degrees. */
export const BANDS = [
  ['red', 0],
  ['orange', 30],
  ['yellow', 60],
  ['green', 120],
  ['aqua', 180],
  ['blue', 240],
  ['purple', 270],
  ['magenta', 300]
] as const
/** Each tab edits one band property. It has a label key and track colors for a band's hue. */
const TABS = [
  ['hue', 'hue', (hue: number) => [hsl(hue - 30), hsl(hue), hsl(hue + 30)]],
  ['saturation', 'saturation', (hue: number) => [hsl(hue, 0), hsl(hue, 100, 50)]],
  ['luminance', 'lightness', (hue: number) => [hsl(hue, 70, 15), hsl(hue, 70, 85)]]
] as const

/** One slider per color band for the property of the selected tab. */
export function ColorMixer({ recipe }: { recipe: EditRecipe }): React.JSX.Element {
  const [tab, setTab] = useState(0)
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const [key, , colors] = TABS[tab]
  const set = (band: number, value: number, save = true): void =>
    change(
      {
        hsl: recipe.hsl.map((entry, index) => (index === band ? { ...entry, [key]: value } : entry))
      },
      save
    )
  return (
    <>
      <div
        role="tablist"
        aria-label={t('editor.colorMixer')}
        className="flex rounded-lg bg-ink/5 p-0.5"
      >
        {TABS.map(([value, label], index) => (
          <Button
            key={value}
            id={`color-mixer-tab-${value}`}
            type="button"
            variant="ghost"
            size="sm"
            role="tab"
            aria-selected={tab === index}
            aria-controls="color-mixer-panel"
            tabIndex={tab === index ? 0 : -1}
            onClick={() => setTab(index)}
            onKeyDown={(event) => {
              const count = TABS.length
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % count
                  : event.key === 'ArrowLeft'
                    ? (index + count - 1) % count
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? count - 1
                        : -1
              if (next < 0) return
              event.preventDefault()
              setTab(next)
              document.getElementById(`color-mixer-tab-${TABS[next][0]}`)?.focus()
            }}
            className="flex-1 justify-center aria-selected:bg-ink/15 aria-selected:text-tone-100"
          >
            {t(`editor.${label}`)}
          </Button>
        ))}
      </div>
      <div role="tabpanel" id="color-mixer-panel" aria-labelledby={`color-mixer-tab-${key}`}>
        {BANDS.map(([name, hue], band) => (
          <Adjustment
            key={name}
            label={t(`editor.${name}`)}
            value={recipe.hsl[band][key]}
            track={`linear-gradient(to right, ${colors(hue).join(', ')})`}
            change={(value, save) => set(band, value, save)}
            reset={() => set(band, 0)}
            commit={commit}
          />
        ))}
      </div>
    </>
  )
}
