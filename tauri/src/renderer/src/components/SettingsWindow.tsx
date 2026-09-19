import { useEffect, useState } from 'react'
import type { LogSizes } from '@shared/ipc'
import { ipc } from '../lib/ipc'
import { useSettingsStore } from '../stores/settingsStore'
import { formatBytes } from '../lib/format'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { Row, Section, ToggleRow } from './ui/settingsLayout'

/** Settings window (port of SettingsView). Backed by the Rust settings service. */
export function SettingsWindow(): React.JSX.Element {
  const loaded = useSettingsStore((s) => s.loaded)
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  const [version, setVersion] = useState('')
  const [logSizes, setLogSizes] = useState<LogSizes>({ conversion: 0, error: 0, debug: 0 })

  const refreshLogSizes = (): void => {
    void ipc.invoke('logs:sizes').then(setLogSizes)
  }

  useEffect(() => {
    const refresh = (): void => void useSettingsStore.getState().load()
    refresh()
    window.addEventListener('focus', refresh)
    void ipc.invoke('app:info').then((info) => setVersion(info.version))
    refreshLogSizes()
    return () => window.removeEventListener('focus', refresh)
  }, [])

  if (!loaded) {
    return <div className="h-full bg-neutral-950" />
  }

  return (
    <div className="h-full overflow-y-auto bg-neutral-950 px-6 py-5 text-neutral-100">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
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
