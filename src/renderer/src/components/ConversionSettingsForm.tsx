import { useState } from 'react'
import {
  COLOR_MODES,
  DEFAULT_EXPORT_RESIZE,
  MAX_RESIZE_DIMENSION,
  RESIZE_METHODS,
  shouldShowCineonOption,
  shouldShowColorModeOption,
  shouldShowColorProfileOption,
  shouldShowCompressionOption,
  shouldShowDngHighlightRecoveryOption,
  type BatchConversionSettings,
  type ColorMode,
  type ColorProfile,
  type OutputFormat,
  type ResizeMethod
} from '@shared/types'
import type { X3iSource } from '@shared/editor'
import { blurOnEnter } from '../lib/commitFocus'
import { ipc } from '../lib/ipc'
import { basename } from '../lib/path'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { Select } from './ui/select'
import { Row, ToggleRow } from './ui/settingsLayout'
import { Adjustment, Section } from './EditorControls'
import { DenoiseControls } from './DenoiseControls'

const FORMAT_OPTIONS: { value: OutputFormat; label: string }[] = [
  { value: 'dng', label: 'DNG (default)' },
  { value: 'embeddedJpg', label: 'Embedded JPG' },
  { value: 'tiff', label: 'TIFF' }
]

const COLOR_OPTIONS: { value: ColorProfile; label: string }[] = [
  { value: 'sRGB', label: 'sRGB (default)' },
  { value: 'adobeRGB', label: 'AdobeRGB' },
  { value: 'proPhotoRGB', label: 'ProPhotoRGB' },
  { value: 'none', label: 'None' }
]

/** A pixel dimension. Only whole numbers from 1 to MAX_RESIZE_DIMENSION change the setting.
    Other text shows until the field loses focus. */
function PixelInput({
  label,
  value,
  change
}: {
  label: string
  value: number
  change: (value: number) => void
}): React.JSX.Element {
  const [text, setText] = useState<string>()
  return (
    <input
      aria-label={label}
      type="number"
      inputMode="numeric"
      min={1}
      max={MAX_RESIZE_DIMENSION}
      step={1}
      value={text ?? String(value)}
      className="h-7 w-20 rounded-md border border-ink/15 bg-ink/[0.03] px-2 text-right font-sans text-[12px] tabular-nums text-tone-100 [appearance:textfield] focus:border-ink/40 focus:outline-none disabled:opacity-40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      onKeyDown={blurOnEnter}
      onBlur={() => setText(undefined)}
      onChange={(event) => {
        setText(event.currentTarget.value)
        const next = event.currentTarget.valueAsNumber
        if (Number.isInteger(next) && next >= 1 && next <= MAX_RESIZE_DIMENSION) change(next)
      }}
    />
  )
}

/**
 * Edits only the current export draft; persistence happens on commit.
 */
export function ConversionSettingsForm({
  settings,
  update,
  renderedOnly = false,
  hasDng = false,
  hasX3i = false,
  partialX3i = false,
  cameraModels = [],
  disabled = false
}: {
  settings: BatchConversionSettings
  renderedOnly?: boolean
  /** The files include a DNG, which exports only rendered images. */
  hasDng?: boolean
  hasX3i?: boolean
  partialX3i?: boolean
  cameraModels?: readonly (string | undefined)[]
  disabled?: boolean
  update: (patch: Partial<BatchConversionSettings>) => void
}): React.JSX.Element {
  const format = settings.outputFormat
  const rendered = settings.rendering === 'rendered'
  const saveAlongside = settings.outputDirectory === null

  async function pickOutputDir(): Promise<void> {
    const dir = await ipc.invoke('dialog:pickOutputDir')
    if (dir) update({ outputDirectory: dir })
  }

  async function onSaveAlongsideChange(useSame: boolean): Promise<void> {
    if (useSame) {
      update({ outputDirectory: null })
    } else if (settings.outputDirectory === null) {
      await pickOutputDir()
    }
  }

  return (
    <>
      {/* Output */}
      <Section id="export-output" name={t('settings.section.output')}>
        <div className="flex flex-col gap-3">
          <ToggleRow
            label={t('settings.save_alongside_original')}
            help={`${t('settings.save_alongside_original.help')} ${t('settings.save_alongside_original.description')}`}
            checked={saveAlongside}
            onChange={(v) => void onSaveAlongsideChange(v)}
          />
          {!saveAlongside && (
            <div className="flex items-center justify-between gap-3">
              <span className="control-label">{t('settings.output_location')}</span>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="truncate text-xs text-tone-400"
                  title={settings.outputDirectory ?? ''}
                >
                  {settings.outputDirectory
                    ? basename(settings.outputDirectory)
                    : t('placeholder.dash')}
                </span>
                <Button variant="bordered" size="sm" onClick={() => void pickOutputDir()}>
                  {t('button.browse')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Conversion */}
      <Section id="export-conversion" name={t('settings.section.conversion')}>
        <div className="flex flex-col gap-3">
          {!renderedOnly && (
            <Row label={t('editor.exportRendering')}>
              <Select
                aria-label={t('editor.exportRendering')}
                value={settings.rendering ?? 'original'}
                options={[
                  { value: 'original', label: t('editor.originalExport') },
                  { value: 'rendered', label: t('editor.renderedExport') }
                ]}
                onValueChange={(rendering) =>
                  update(
                    rendering === 'rendered'
                      ? {
                          rendering,
                          outputFormat: format === 'tiff' ? 'tiff' : 'jpeg',
                          cineon: false,
                          colorProfile:
                            settings.colorProfile === 'none' ? 'sRGB' : settings.colorProfile
                        }
                      : { rendering, outputFormat: format === 'jpeg' ? 'dng' : format }
                  )
                }
              />
            </Row>
          )}
          {rendered && (
            <p className="text-xs text-tone-500">
              {t(hasDng ? 'export.dng_rendered_only' : 'editor.renderedExportHint')}
            </p>
          )}
          <Row label={t('settings.conversion_format')}>
            <Select
              aria-label={t('settings.conversion_format')}
              value={format}
              options={
                rendered
                  ? [
                      { value: 'jpeg', label: 'JPEG' },
                      { value: 'tiff', label: 'TIFF (16-bit)' }
                    ]
                  : FORMAT_OPTIONS
              }
              onValueChange={(v) => update({ outputFormat: v })}
            />
          </Row>

          {shouldShowCompressionOption(format) && (
            <ToggleRow
              label={t('settings.raw_compression')}
              help={t('settings.raw_compression.warning')}
              checked={settings.compress}
              onChange={(v) => update({ compress: v })}
            />
          )}

          {!rendered && shouldShowDngHighlightRecoveryOption(format, cameraModels) && (
            <ToggleRow
              label={t('settings.dng_highlight_recovery')}
              help={t('settings.dng_highlight_recovery.warning')}
              warning={
                cameraModels.some((model) => !shouldShowDngHighlightRecoveryOption(format, [model]))
                  ? t('export.partial_highlight_recovery')
                  : undefined
              }
              checked={settings.dngHighlightRecovery}
              onChange={(v) => update({ dngHighlightRecovery: v })}
            />
          )}

          {!rendered && shouldShowCineonOption(format) && (
            <ToggleRow
              label={t('settings.cineon')}
              help={t('settings.cineon.help')}
              checked={settings.cineon}
              onChange={(v) => update({ cineon: v })}
            />
          )}

          {(rendered || shouldShowColorProfileOption(format)) && (
            <Row label={t('settings.color_profile')}>
              <Select
                aria-label={t('settings.color_profile')}
                value={settings.colorProfile}
                options={
                  rendered
                    ? COLOR_OPTIONS.filter((option) => option.value !== 'none')
                    : COLOR_OPTIONS
                }
                onValueChange={(v) => update({ colorProfile: v })}
              />
            </Row>
          )}

          {!rendered && shouldShowColorModeOption(settings) && (
            <Row label={t('settings.color_mode')} help={t('settings.color_mode.help')}>
              <Select<ColorMode | 'off'>
                aria-label={t('settings.color_mode')}
                value={settings.colorMode ?? 'off'}
                options={[
                  { value: 'off', label: t('settings.color_mode.off') },
                  { value: 'as-shot', label: t('editor.asShot') },
                  ...COLOR_MODES.map(([value, label]) => ({
                    value,
                    label: value === 'Standard' ? t('editor.standard') : label
                  }))
                ]}
                onValueChange={(v) => update({ colorMode: v === 'off' ? null : v })}
              />
            </Row>
          )}

          {rendered && format === 'jpeg' && (
            <div className="space-y-2">
              <span className="control-label">
                {t('editor.jpegQuality')} ({settings.jpegQuality})
              </span>
              <Slider
                aria-label={t('editor.jpegQuality')}
                value={settings.jpegQuality}
                min={1}
                max={100}
                onValueChange={(jpegQuality) => update({ jpegQuality })}
              />
            </div>
          )}

          {(rendered || format === 'jpeg') && (
            <>
              <ToggleRow
                label={t('export.resize')}
                help={t('export.resize.help')}
                checked={settings.resize !== null}
                onChange={(on) => update({ resize: on ? { ...DEFAULT_EXPORT_RESIZE } : null })}
              />
              {settings.resize && (
                <>
                  <Row label={t('export.resize.max_width')}>
                    <PixelInput
                      label={t('export.resize.max_width')}
                      value={settings.resize.maxWidth}
                      change={(maxWidth) => update({ resize: { ...settings.resize!, maxWidth } })}
                    />
                  </Row>
                  <Row label={t('export.resize.max_height')}>
                    <PixelInput
                      label={t('export.resize.max_height')}
                      value={settings.resize.maxHeight}
                      change={(maxHeight) => update({ resize: { ...settings.resize!, maxHeight } })}
                    />
                  </Row>
                  <Row label={t('export.resize.method')}>
                    <Select<ResizeMethod>
                      aria-label={t('export.resize.method')}
                      value={settings.resize.method}
                      options={RESIZE_METHODS.map((value) => ({
                        value,
                        label: t(`export.resize.method.${value}`)
                      }))}
                      onValueChange={(method) =>
                        update({ resize: { ...settings.resize!, method } })
                      }
                    />
                  </Row>
                </>
              )}
            </>
          )}
        </div>
      </Section>
      {hasX3i && !rendered && format !== 'embeddedJpg' && (
        <Section id="export-sfd" name={t('editor.x3iSourceMerge')}>
          <Row
            label={t('editor.x3iSource')}
            help={t('settings.x3i_source.help')}
            warning={partialX3i ? t('export.partial_sfd_source') : undefined}
          >
            <Select<X3iSource>
              aria-label={t('editor.x3iSource')}
              value={settings.x3iSource ?? 'merge'}
              options={[
                { value: 'merge', label: t('editor.x3iSourceMerge') },
                { value: 'middle_exposure', label: t('editor.x3iSourceMiddle') }
              ]}
              onValueChange={(x3iSource) => update({ x3iSource })}
            />
          </Row>
        </Section>
      )}

      {!rendered && format !== 'embeddedJpg' && (
        <Section id="export-denoise" name={t('editor.detail')}>
          <Adjustment
            label={t('editor.denoise')}
            value={settings.denoiseIntensity}
            min={0}
            max={10}
            disabled={disabled}
            help={t('settings.denoise.help')}
            change={(denoiseIntensity) => update({ denoiseIntensity })}
            reset={() => update({ denoiseIntensity: 10 })}
          />
          {settings.denoiseIntensity > 0 && (
            <DenoiseControls
              value={settings.denoiseOptions}
              change={(denoiseOptions) => update({ denoiseOptions })}
            />
          )}
        </Section>
      )}
    </>
  )
}
