import { RectangleHorizontal, RotateCcw, RotateCcwSquare, RotateCwSquare } from 'lucide-react'
import type { EditRecipe } from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { t } from '../lib/strings'
import { PRESETS, FULL, outputRatio, ratioCrop } from '../lib/cropGeometry'
import { Button } from './ui/button'
import { Adjustment } from './EditorControls'

/** A small outline of the frame shape an aspect option produces. */
function Shape({ ratio, dashed }: { ratio: number; dashed?: boolean }): React.JSX.Element {
  const width = ratio >= 1 ? 18 : 18 * ratio
  const height = ratio >= 1 ? 18 / ratio : 18
  return (
    <span className="flex h-5 items-center justify-center" aria-hidden="true">
      <span
        className={`block rounded-[2px] border-[1.5px] border-current ${dashed ? 'border-dashed' : ''}`}
        style={{ width, height }}
      />
    </span>
  )
}

/** Crop mode replaces the adjustments, as in Photos: the frame is edited on the image. */
export function CropControls({
  recipe,
  aspect,
  setAspect
}: {
  recipe: EditRecipe
  aspect: string
  setAspect: (aspect: string) => void
}): React.JSX.Element {
  const change = useEditorStore((state) => state.change)
  const commit = useEditorStore((state) => state.commit)
  const setCropping = useEditorStore((state) => state.setCropping)
  const asShotCrop = useEditorStore((state) => state.session?.asShotCrop ?? null)
  const W = useEditorStore((state) => state.preview?.sourceWidth)
  const H = useEditorStore((state) => state.preview?.sourceHeight)
  const crop = recipe.crop ?? FULL
  const rotation = recipe.rotation
  const current = W && H ? outputRatio(crop, rotation, W, H) : 1
  const portrait = current < 1
  const asShot = W && H ? outputRatio(asShotCrop ?? FULL, 0, W, H) : 1.5
  const options = [
    { value: 'asShot', label: t('editor.asShot'), ratio: asShot },
    { value: 'free', label: t('editor.free'), ratio: current, dashed: true },
    ...PRESETS.map(([a, b]) => ({
      value: `${a}:${b}`,
      label: a === 65 ? 'XPan' : portrait ? `${b}:${a}` : `${a}:${b}`,
      ratio: portrait ? b / a : a / b
    }))
  ]
  const choose = (value: string): void => {
    setAspect(value)
    if (value === 'asShot') change({ crop: asShotCrop })
    else if (value !== 'free' && W && H) {
      const [a, b] = value.split(':').map(Number)
      change({ crop: ratioCrop(portrait ? b / a : a / b, rotation, W, H) })
    }
  }
  return (
    <div className="mx-3 mt-3 space-y-4 rounded-xl border border-white/10 px-4 py-3">
      <h2 className="control-label tracking-[0.16em]">{t('editor.geometry')}</h2>
      <div className="flex items-center justify-between gap-2">
        <span className="control-label text-[10px] text-neutral-500">
          {t('editor.aspectRatio')}
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('editor.swapOrientation')}
          title={t('editor.swapOrientation')}
          disabled={!W || !H || Math.abs(current - 1) < 0.001}
          onClick={() => W && H && change({ crop: ratioCrop(1 / current, rotation, W, H) })}
        >
          <RectangleHorizontal
            aria-hidden="true"
            className={`h-4 w-4 transition-transform ${portrait ? 'rotate-90' : ''}`}
          />
        </Button>
      </div>
      <div
        role="radiogroup"
        aria-label={t('editor.aspectRatio')}
        className="grid grid-cols-5 gap-1.5"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === aspect}
            disabled={!W || !H}
            title={option.value === '65:24' ? 'XPan 65:24' : option.label}
            onClick={() => choose(option.value)}
            className="flex flex-col items-center gap-1 rounded-lg border border-transparent px-0.5 py-1.5 text-[10px] leading-none text-neutral-400 hover:bg-white/5 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-40 aria-checked:border-white/30 aria-checked:bg-white/10 aria-checked:text-white"
          >
            <Shape ratio={option.ratio} dashed={option.dashed} />
            <span className="max-w-full truncate">{option.label}</span>
          </button>
        ))}
      </div>
      <Adjustment
        label={t('editor.straighten')}
        value={recipe.straighten}
        min={-45}
        max={45}
        step={0.1}
        change={(straighten, save) => change({ straighten }, save)}
        reset={() => change({ straighten: 0 })}
        commit={commit}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="bordered"
          aria-label={t('editor.rotateLeft')}
          title={t('editor.rotateLeft')}
          onClick={() => change({ rotation: (rotation + 3) % 4 })}
        >
          <RotateCcwSquare aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="bordered"
          aria-label={t('editor.rotate')}
          title={t('editor.rotate')}
          onClick={() => change({ rotation: (rotation + 1) % 4 })}
        >
          <RotateCwSquare aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="bordered"
          onClick={() => {
            change({ crop: asShotCrop, straighten: 0, rotation: 0 })
            setAspect('asShot')
          }}
        >
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          {t('editor.resetCrop')}
        </Button>
        <Button
          size="sm"
          variant="prominent"
          className="ml-auto"
          onClick={() => setCropping(false)}
        >
          {t('editor.applyCrop')}
        </Button>
      </div>
      <p className="text-[11px] leading-snug text-neutral-500">{t('editor.cropCanvas')}</p>
    </div>
  )
}
