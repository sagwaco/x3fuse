import { useEffect, useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import {
  shouldShowCineonOption,
  shouldShowColorProfileOption,
  shouldShowCompressionOption,
  shouldShowDngHighlightRecoveryOption,
  type ColorProfile,
  type OutputFormat
} from '@shared/types'
import { autoConcurrency, MAX_CONCURRENCY } from '@shared/concurrency'
import type { LogSizes } from '@shared/ipc'
import { ipc } from '../lib/ipc'
import { useSettingsStore } from '../stores/settingsStore'
import { basename } from '../lib/path'
import { formatBytes } from '../lib/format'
import { t } from '../lib/strings'
import { cn } from '../lib/cn'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { Slider } from './ui/slider'
import { Select } from './ui/select'

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

/** Settings window (port of SettingsView). Backed by the main-process SettingsService. */
export function SettingsWindow(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const loaded = useSettingsStore((s) => s.loaded)
  const update = useSettingsStore((s) => s.update)

  // Remember the last non-zero denoise intensity so toggling Off→On restores it.
  const lastDenoise = useRef(settings.denoiseIntensity > 0 ? settings.denoiseIntensity : 10)

  const [version, setVersion] = useState('')
  const [logSizes, setLogSizes] = useState<LogSizes>({ conversion: 0, error: 0, debug: 0 })

  const refreshLogSizes = (): void => {
    void ipc.invoke('logs:sizes').then(setLogSizes)
  }

  useEffect(() => {
    void useSettingsStore.getState().load()
    void ipc.invoke('app:info').then((info) => setVersion(info.version))
    refreshLogSizes()
  }, [])

  useEffect(() => {
    if (settings.denoiseIntensity > 0) lastDenoise.current = settings.denoiseIntensity
  }, [settings.denoiseIntensity])

  if (!loaded) {
    return <div className="h-full bg-neutral-950" />
  }

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
    <div className="h-full overflow-y-auto bg-neutral-950 px-6 py-5 text-neutral-100">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
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

        {/* Debug */}
        <Section title={t('settings.section.debug')}>
          <ToggleRow
            label={t('settings.debug_logging')}
            checked={settings.debugLoggingEnabled}
            onChange={(v) => void update({ debugLoggingEnabled: v })}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-neutral-300">{t('settings.debug_logs')}</span>
            <div className="flex items-center gap-2">
              <Button variant="bordered" size="sm" onClick={() => void ipc.invoke('logs:open')}>
                {t('settings.open_logs_folder')}
              </Button>
              <Button
                variant="bordered"
                size="sm"
                onClick={() => void ipc.invoke('logs:clear').then(refreshLogSizes)}
              >
                {t('settings.clear_logs')}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1 text-xs text-neutral-500">
            <LogSizeRow label={t('settings.log.conversion')} bytes={logSizes.conversion} />
            <LogSizeRow label={t('settings.log.error')} bytes={logSizes.error} />
            <LogSizeRow label={t('settings.log.debug')} bytes={logSizes.debug} />
          </div>
        </Section>

        {/* Updates */}
        <Section title={t('settings.section.updates')}>
          <ToggleRow
            label={t('updates.automatic_updates')}
            checked={settings.autoCheckUpdates}
            onChange={(v) => void update({ autoCheckUpdates: v })}
          />
          <ToggleRow
            label={t('updates.automatic_download')}
            checked={settings.autoDownloadUpdates}
            onChange={(v) => void update({ autoDownloadUpdates: v })}
          />
          <div className="flex items-center justify-end">
            <Button variant="bordered" size="sm" onClick={() => void ipc.invoke('update:check')}>
              {t('updates.check_for_updates')}
            </Button>
          </div>
        </Section>

        {/* About */}
        <Section title={t('settings.section.about')}>
          <InfoRow label={t('settings.version')} value={version || '—'} />
        </Section>
      </div>
    </div>
  )
}

// --- Layout primitives ---

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
      <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-4">
        {children}
      </div>
    </section>
  )
}

function Row({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-300">{label}</span>
      {children}
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <Row label={label}>
      <Switch checked={checked} onCheckedChange={onChange} />
    </Row>
  )
}

function InfoRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Row label={label}>
      <span className="text-sm text-neutral-400">{value}</span>
    </Row>
  )
}

function LogSizeRow({ label, bytes }: { label: string; bytes: number }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span>{formatBytes(bytes)}</span>
    </div>
  )
}

function Divider(): React.JSX.Element {
  return <div className="h-px bg-white/10" />
}

function Callout({ text }: { text: string }): React.JSX.Element {
  return (
    <div className={cn('flex items-start gap-2 rounded-md bg-white/5 px-3 py-2')}>
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/80" />
      <span className="text-xs text-neutral-400">{text}</span>
    </div>
  )
}
