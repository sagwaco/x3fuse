import { useEffect, useRef } from 'react'
import {
  shouldShowCineonOption,
  shouldShowColorProfileOption,
  shouldShowCompressionOption,
  shouldShowDngHighlightRecoveryOption,
  type BatchConversionSettings,
  type ColorProfile,
  type OutputFormat
} from '@shared/types'
import { MAX_CONCURRENCY } from '@shared/concurrency'
import { appInfo } from '../lib/appInfo'
import { ipc } from '../lib/ipc'
import { basename } from '../lib/path'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { Select } from './ui/select'
import { Divider, Row, ToggleRow } from './ui/settingsLayout'
import { PanelSection as Section } from './ui/panelSection'

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

// The Rust backend reports the actual automatic worker count.
function concurrencyOptions(): { value: string; label: string }[] {
  const auto = appInfo.autoConcurrency
  return [
    { value: '0', label: `${t('settings.concurrency.auto')} (${auto})` },
    ...Array.from({ length: MAX_CONCURRENCY }, (_, i) => ({
      value: String(i + 1),
      label: String(i + 1)
    }))
  ]
}

/**
 * Edits only the current export draft; persistence happens on commit.
 */
export function ConversionSettingsForm({
  settings,
  update,
  renderedOnly = false
}: {
  settings: BatchConversionSettings
  renderedOnly?: boolean
  update: (patch: Partial<BatchConversionSettings>) => void
}): React.JSX.Element {
  // Remember the last non-zero denoise intensity so toggling Off→On restores it.
  const lastDenoise = useRef(settings.denoiseIntensity > 0 ? settings.denoiseIntensity : 10)

  useEffect(() => {
    if (settings.denoiseIntensity > 0) lastDenoise.current = settings.denoiseIntensity
  }, [settings.denoiseIntensity])

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

  function setDenoiseEnabled(enabled: boolean): void {
    if (enabled) update({ denoiseIntensity: lastDenoise.current || 10 })
    else {
      lastDenoise.current = settings.denoiseIntensity
      update({ denoiseIntensity: 0 })
    }
  }

  return (
    <>
      {/* Output */}
      <Section title={t('settings.section.output')}>
        <div className="flex flex-col gap-3">
          <ToggleRow
            labelClassName="text-xs text-neutral-300"
            label={t('settings.save_alongside_original')}
            help={`${t('settings.save_alongside_original.help')} ${t('settings.save_alongside_original.description')}`}
            checked={saveAlongside}
            onChange={(v) => void onSaveAlongsideChange(v)}
          />
          {!saveAlongside && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-neutral-300">{t('settings.output_location')}</span>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="truncate font-mono text-xs text-neutral-400"
                  title={settings.outputDirectory ?? ''}
                >
                  {settings.outputDirectory ? basename(settings.outputDirectory) : '—'}
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
      <Section title={t('settings.section.conversion')}>
        <div className="flex flex-col gap-3">
          {!renderedOnly && (
            <Row labelClassName="text-xs text-neutral-300" label={t('editor.exportRendering')}>
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
          {rendered && <p className="text-xs text-neutral-500">{t('editor.renderedExportHint')}</p>}
          <Row labelClassName="text-xs text-neutral-300" label={t('settings.conversion_format')}>
            <Select
              className="text-xs text-neutral-200"
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
              labelClassName="text-xs text-neutral-300"
              label={t('settings.raw_compression')}
              help={t('settings.raw_compression.warning')}
              checked={settings.compress}
              onChange={(v) => update({ compress: v })}
            />
          )}

          {!rendered && shouldShowDngHighlightRecoveryOption(format) && (
            <ToggleRow
              labelClassName="text-xs text-neutral-300"
              label={t('settings.dng_highlight_recovery')}
              help={t('settings.dng_highlight_recovery.warning')}
              checked={settings.dngHighlightRecovery}
              onChange={(v) => update({ dngHighlightRecovery: v })}
            />
          )}

          {!rendered && shouldShowCineonOption(format) && (
            <ToggleRow
              labelClassName="text-xs text-neutral-300"
              label={t('settings.cineon')}
              help={t('settings.cineon.help')}
              checked={settings.cineon}
              onChange={(v) => update({ cineon: v })}
            />
          )}

          {(rendered || shouldShowColorProfileOption(format)) && (
            <Row labelClassName="text-xs text-neutral-300" label={t('settings.color_profile')}>
              <Select
                className="text-xs text-neutral-200"
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

          {rendered && format === 'jpeg' && (
            <div className="space-y-2">
              <span className="text-xs text-neutral-300">
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
          {!rendered && (
            <>
              <Divider />

              <ToggleRow
                labelClassName="text-xs text-neutral-300"
                label={t('settings.denoise')}
                help={t('settings.denoise.help')}
                checked={settings.denoiseIntensity > 0}
                onChange={setDenoiseEnabled}
              />
              {settings.denoiseIntensity > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-neutral-300">
                    {t('settings.denoise.intensity')}
                  </span>
                  <Slider
                    value={settings.denoiseIntensity}
                    min={1}
                    max={10}
                    onValueChange={(v) => update({ denoiseIntensity: v })}
                  />
                  <div className="flex justify-between text-xs font-semibold text-neutral-500">
                    <span>{t('settings.denoise.intensity.less')}</span>
                    <span>{t('settings.denoise.intensity.more')}</span>
                  </div>
                </div>
              )}
            </>
          )}
          {!rendered && (
            <>
              <Divider />

              <Row
                labelClassName="text-xs text-neutral-300"
                label={t('settings.concurrency')}
                help={t('settings.concurrency.help')}
              >
                <Select
                  className="text-xs text-neutral-200"
                  aria-label={t('settings.concurrency')}
                  value={String(settings.concurrency)}
                  options={concurrencyOptions()}
                  onValueChange={(v) => update({ concurrency: Number(v) })}
                />
              </Row>
            </>
          )}
        </div>
      </Section>
    </>
  )
}
