import { useContext, useRef, useState } from 'react'
import { MoveVertical, RectangleHorizontal, Spline } from 'lucide-react'
import type { EditRecipe } from '@shared/editor'
import { useEditorStore } from '../stores/editorStore'
import { t } from '../lib/strings'
import { PRESETS, FULL, centeredCrop, fitCrop, outputRatio, ratioCrop } from '../lib/cropGeometry'
import { level, upright } from '../lib/upright'
import { useScopeImage } from '../hooks/useScopeImage'
import { DevelopingCloud } from '../lib/developingCloud'
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
  const asShotCrop = useEditorStore((state) => state.session?.asShotCrop ?? null)
  const W = useEditorStore((state) => state.preview?.sourceWidth)
  const H = useEditorStore((state) => state.preview?.sourceHeight)
  const url = useEditorStore((state) => state.preview?.url)
  const rendering = useEditorStore((state) => state.rendering)
  const pose = useEditorStore((state) => state.previewPose)
  // The crop-mode preview is the corrected picture, unstraightened and uncropped.
  // Reading the picture waits until the developing cloud leaves.
  const picture = useScopeImage(useContext(DevelopingCloud) ? undefined : url)
  const [status, setStatus] = useState('')
  // A failed or pending render leaves old pixels; only analyze a preview made with these angles.
  const posed = pose?.pitch === recipe.pitch && pose?.yaw === recipe.yaw
  const ready = typeof picture === 'object' && picture !== null && !rendering && posed && !!W && !!H
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
  /**
   * Shrink the crop when a new angle or perspective would show empty corners.
   * `from` is the crop to fit; a slider gesture passes the crop it started with.
   */
  const withFit = (
    patch: Partial<EditRecipe>,
    from: EditRecipe['crop'] = recipe.crop
  ): Partial<EditRecipe> => {
    if (!W || !H) return patch
    const next = { ...recipe, ...patch }
    const base = 'crop' in patch ? (patch.crop ?? null) : from
    const fitted = fitCrop(base ?? FULL, next.straighten, next.pitch, next.yaw, W, H)
    const crop = fitted === (base ?? FULL) ? base : fitted
    return crop === recipe.crop && !('crop' in patch) ? patch : { ...patch, crop }
  }
  // Slider moves refit from the crop at the start of the drag, so dragging back
  // restores the frame. A drag ends with a saved change or the commit at release.
  // A drag that returns to its start value has no commit, so any other crop
  // change (presets, undo, the toolbar) also starts a new drag.
  const gesture = useRef<{ start: EditRecipe['crop']; last: EditRecipe['crop'] } | null>(null)
  const slide = (patch: Partial<EditRecipe>, save: boolean): void => {
    if (gesture.current?.last !== recipe.crop)
      gesture.current = { start: recipe.crop, last: recipe.crop }
    const next = withFit(patch, gesture.current.start)
    gesture.current.last = 'crop' in next ? (next.crop ?? null) : recipe.crop
    change(next, save)
    if (save) gesture.current = null
  }
  const release = (): void => {
    gesture.current = null
    commit()
  }
  const choose = (value: string): void => {
    setAspect(value)
    if (value === 'asShot') change(withFit({ crop: asShotCrop }))
    else if (value !== 'free' && W && H) {
      const [a, b] = value.split(':').map(Number)
      change(withFit({ crop: ratioCrop(portrait ? b / a : a / b, rotation, W, H) }))
    }
  }
  const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value))
  const straightenPicture = (): void => {
    const angle = ready ? level(picture, { pitch: recipe.pitch, yaw: recipe.yaw }, W!, H!) : null
    setStatus(angle === null ? t('editor.noLines') : '')
    if (angle !== null) change(withFit({ straighten: clamp(angle, 45) }), true)
  }
  const uprightPicture = (): void => {
    const found = ready ? upright(picture, { pitch: recipe.pitch, yaw: recipe.yaw }, W, H) : null
    setStatus(found ? '' : t('editor.noLines'))
    if (!found) return
    const straighten = clamp(found.straighten, 45)
    const pitch = clamp(found.pitch, 40)
    const yaw = clamp(found.yaw, 40)
    const aspect = (crop.width * W!) / (crop.height * H!)
    change(
      {
        straighten,
        pitch,
        yaw,
        crop: centeredCrop(aspect, straighten, pitch, yaw, W!, H!) ?? crop
      },
      true
    )
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
          onClick={() =>
            W && H && change(withFit({ crop: ratioCrop(1 / current, rotation, W, H) }))
          }
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
        change={(straighten, save) => slide({ straighten }, save)}
        reset={() => change(withFit({ straighten: 0 }))}
        commit={release}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="bordered"
          title={t('editor.levelPictureHint')}
          disabled={!ready}
          onClick={straightenPicture}
        >
          <Spline aria-hidden="true" className="h-3.5 w-3.5" />
          {t('editor.levelPicture')}
        </Button>
        <Button
          size="sm"
          variant="bordered"
          title={t('editor.uprightHint')}
          disabled={!ready}
          onClick={uprightPicture}
        >
          <MoveVertical aria-hidden="true" className="h-3.5 w-3.5" />
          {t('editor.upright')}
        </Button>
      </div>
      {status && (
        <p role="status" className="text-[11px] leading-snug text-neutral-400">
          {status}
        </p>
      )}
      <p className="control-label pt-1 text-[10px] text-neutral-500">{t('editor.perspective')}</p>
      <Adjustment
        label={t('editor.perspectiveVertical')}
        help={t('editor.perspectiveVerticalHelp')}
        value={recipe.pitch}
        min={-40}
        max={40}
        step={0.1}
        change={(pitch, save) => slide({ pitch }, save)}
        reset={() => change(withFit({ pitch: 0 }))}
        commit={release}
      />
      <Adjustment
        label={t('editor.perspectiveHorizontal')}
        help={t('editor.perspectiveHorizontalHelp')}
        value={recipe.yaw}
        min={-40}
        max={40}
        step={0.1}
        change={(yaw, save) => slide({ yaw }, save)}
        reset={() => change(withFit({ yaw: 0 }))}
        commit={release}
      />
      <p className="text-[11px] leading-snug text-neutral-500">{t('editor.cropCanvas')}</p>
    </div>
  )
}
