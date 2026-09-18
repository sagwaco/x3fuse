import { useEffect, useRef } from 'react'
import {
  shouldShowCineonOption,
  shouldShowColorProfileOption,
  shouldShowCompressionOption,
  shouldShowDngHighlightRecoveryOption,
  type ColorProfile,
  type OutputFormat
} from '@shared/types'
import { autoConcurrency, MAX_CONCURRENCY } from '@shared/concurrency'
import { ipc } from '../lib/ipc'
import { useSettingsStore } from '../stores/settingsStore'
import { basename } from '../lib/path'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { Select } from './ui/select'
import { Callout, Divider, Row, Section, ToggleRow } from './ui/settingsLayout'

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

// "0" = auto; show the value auto resolves to on this device so users can
// judge the manual options against it. navigator.hardwareConcurrency mirrors
// the core count the main process derives the pool size from.
function concurrencyOptions(): { value: string; label: string }[] {
  const auto = autoConcurrency(navigator.hardwareConcurrency || 1)
  return [
    { value: '0', label: `${t('settings.concurrency.auto')} (${auto})` },
    ...Array.from({ length: MAX_CONCURRENCY }, (_, i) => ({
      value: String(i + 1),
      label: String(i + 1)
    }))
  ]
}

/**
 * The Output + Conversion settings sections, backed by the main-process
 * SettingsService. Shared by the Settings window (alongside Debug/Updates/About)
 * and the Export screen's sidebar so both edit the same authoritative settings
 * with identical controls.
 */
export function ConversionSettingsForm(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  // Remember the last non-zero denoise intensity so toggling Off→On restores it.
  const lastDenoise = useRef(settings.denoiseIntensity > 0 ? settings.denoiseIntensity : 10)

  useEffect(() => {
    if (settings.denoiseIntensity > 0) lastDenoise.current = settings.denoiseIntensity
  }, [settings.denoiseIntensity])

  const format = settings.outputFormat
  const saveAlongside = settings.outputDirectory === null

  async function pickOutputDir(): Promise<void> {
    const dir = await ipc.invoke('dialog:pickOutputDir')
    if (dir) await update({ outputDirectory: dir })
  }

  async function onSaveAlongsideChange(useSame: boolean): Promise<void> {
    if (useSame) {
      await update({ outputDirectory: null })
    } else if (settings.outputDirectory === null) {
      await pickOutputDir()
    }
  }

  function setDenoiseEnabled(enabled: boolean): void {
    if (enabled) void update({ denoiseIntensity: lastDenoise.current || 10 })
    else {
      lastDenoise.current = settings.denoiseIntensity
      void update({ denoiseIntensity: 0 })
    }
  }

  return (
    <>
      {/* Output */}
      <Section title={t('settings.section.output')}>
        <ToggleRow
          label={t('settings.save_alongside_original')}
          checked={saveAlongside}
          onChange={(v) => void onSaveAlongsideChange(v)}
        />
        {saveAlongside ? (
          <p className="text-xs text-neutral-500">
            {t('settings.save_alongside_original.description')}
          </p>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-neutral-300">{t('settings.output_location')}</span>
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

        <Divider />

        <ToggleRow
          label={t('settings.only_convert_new')}
          checked={settings.onlyProcessNewItems}
          onChange={(v) => void update({ onlyProcessNewItems: v })}
        />
      </Section>

      {/* Conversion */}
      <Section title={t('settings.section.conversion')}>
        <Row label={t('settings.conversion_format')}>
          <Select
            value={format}
            options={FORMAT_OPTIONS}
            onValueChange={(v) => void update({ outputFormat: v })}
          />
        </Row>

        {shouldShowCompressionOption(format) && (
          <>
            <ToggleRow
              label={t('settings.raw_compression')}
              checked={settings.compress}
              onChange={(v) => void update({ compress: v })}
            />
            {settings.compress && <Callout text={t('settings.raw_compression.warning')} />}
          </>
        )}

        {shouldShowDngHighlightRecoveryOption(format) && (
          <>
            <ToggleRow
              label={t('settings.dng_highlight_recovery')}
              checked={settings.dngHighlightRecovery}
              onChange={(v) => void update({ dngHighlightRecovery: v })}
            />
            {settings.dngHighlightRecovery && (
              <Callout text={t('settings.dng_highlight_recovery.warning')} />
            )}
          </>
        )}

        {shouldShowCineonOption(format) && (
          <ToggleRow
            label={t('settings.cineon')}
            checked={settings.cineon}
            onChange={(v) => void update({ cineon: v })}
          />
        )}

        {shouldShowColorProfileOption(format) && (
          <Row label={t('settings.color_profile')}>
            <Select
              value={settings.colorProfile}
              options={COLOR_OPTIONS}
              onValueChange={(v) => void update({ colorProfile: v })}
            />
          </Row>
        )}

        <Divider />

        <ToggleRow
          label={t('settings.denoise')}
          checked={settings.denoiseIntensity > 0}
          onChange={setDenoiseEnabled}
        />
        {settings.denoiseIntensity > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-neutral-300">{t('settings.denoise.intensity')}</span>
            <Slider
              value={settings.denoiseIntensity}
              min={1}
              max={10}
              onValueChange={(v) => void update({ denoiseIntensity: v })}
            />
            <div className="flex justify-between text-xs font-semibold text-neutral-500">
              <span>{t('settings.denoise.intensity.less')}</span>
              <span>{t('settings.denoise.intensity.more')}</span>
            </div>
          </div>
        )}

        <Divider />

        <Row label={t('settings.concurrency')}>
          <Select
            value={String(settings.concurrency)}
            options={concurrencyOptions()}
            onValueChange={(v) => void update({ concurrency: Number(v) })}
          />
        </Row>
        <p className="text-xs text-neutral-500">{t('settings.concurrency.help')}</p>
      </Section>
    </>
  )
}
