import { useState } from 'react'
import type { EditRecipe } from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { t } from '../lib/strings'
import { GlassGroup } from './ui/glassGroup'
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
  const [key, setKey] = useState<(typeof TABS)[number][0]>('hue')
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const colors = TABS.find(([value]) => value === key)![2]
  const set = (band: number, value: number, save = true): void =>
    change(
      {
        hsl: recipe.hsl.map((entry, index) => (index === band ? { ...entry, [key]: value } : entry))
      },
      save
    )
  return (
    <>
      <GlassGroup
        kind="tabs"
        id="color-mixer"
        panelId={() => 'color-mixer-panel'}
        aria-label={t('editor.colorMixer')}
        value={key}
        onValueChange={setKey}
        items={TABS.map(([value, label]) => ({ value, label: t(`editor.${label}`) }))}
        className="grid auto-cols-fr grid-flow-col"
      />
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
