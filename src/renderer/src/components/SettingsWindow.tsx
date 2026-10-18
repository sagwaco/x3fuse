import { useEffect, useState } from 'react'
import { Bug, HardDrive, Info, Palette, RefreshCw } from 'lucide-react'
import type { LogSizes } from '@shared/ipc'
import { ipc } from '../lib/ipc'
import { appInfo } from '../lib/appInfo'
import { checkForUpdates } from '../hooks/useIpcEvents'
import { useSettingsStore } from '../stores/settingsStore'
import { cn } from '../lib/cn'
import { formatBytes } from '../lib/format'
import { t } from '../lib/strings'
import { Button } from './ui/button'
import { GlassGroup } from './ui/glassGroup'
import { Select } from './ui/select'
import { Row, Section, ToggleRow } from './ui/settingsLayout'

const TABS = [
  ['appearance', Palette],
  ['cache', HardDrive],
  ['debug', Bug],
  ['updates', RefreshCw],
  ['about', Info]
] as const
type Tab = (typeof TABS)[number][0]
const TAB_KEY = 'x3fuse.settingsTab'

function savedTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    return TABS.find(([value]) => value === saved)?.[0] ?? 'appearance'
  } catch {
    return 'appearance'
  }
}

/** Settings window (port of SettingsView). Backed by the Rust settings service. */
export function SettingsWindow(): React.JSX.Element {
  const loaded = useSettingsStore((s) => s.loaded)
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  const [tab, setPage] = useState(savedTab)
  const setTab = (next: Tab): void => {
    setPage(next)
    try {
      localStorage.setItem(TAB_KEY, next)
    } catch {
      // Without storage, the window opens on the first tab.
    }
  }
  const [version, setVersion] = useState('')
  const [logSizes, setLogSizes] = useState<LogSizes>({ conversion: 0, error: 0, debug: 0 })

  const refreshLogSizes = (): void => {
    void ipc.invoke('logs:sizes').then(setLogSizes)
  }

  useEffect(() => {
    const refresh = (): void => void useSettingsStore.getState().load()
    refresh()
    window.addEventListener('focus', refresh)
    const off = ipc.on('settings:changed', refresh)
    void ipc.invoke('app:info').then((info) => setVersion(info.version))
    refreshLogSizes()
    return () => {
      window.removeEventListener('focus', refresh)
      off()
    }
  }, [])

  if (!loaded) {
    return <div className="h-full bg-tone-950" />
  }

  return (
    <div className="h-full overflow-y-auto bg-tone-950 text-tone-100">
      <SettingsTitlebar tab={tab} onSelect={setTab} />
      <div
        role="tabpanel"
        id={`settings-page-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
        className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-5"
      >
        {tab === 'appearance' && (
          <Section title={t('settings.section.appearance')}>
            <Row label={t('settings.appearance.mode')}>
              <GlassGroup
                aria-label={t('settings.appearance.mode')}
                value={settings.appearanceMode}
                items={[
                  { value: 'auto', label: t('settings.appearance.auto') },
                  { value: 'light', label: t('theme.light') },
                  { value: 'dark', label: t('theme.dark') }
                ]}
                onValueChange={(v) => void update({ appearanceMode: v })}
              />
            </Row>
            <Row label={t('settings.appearance.light_theme')}>
              <Select
                aria-label={t('settings.appearance.light_theme')}
                value={settings.lightTheme}
                options={[
                  { value: 'light', label: t('theme.light') },
                  { value: 'gray', label: t('theme.gray') },
                  { value: 'dark', label: t('theme.dark') }
                ]}
                onValueChange={(v) => void update({ lightTheme: v })}
              />
            </Row>
            <Row label={t('settings.appearance.dark_theme')}>
              <Select
                aria-label={t('settings.appearance.dark_theme')}
                value={settings.darkTheme}
                options={[
                  { value: 'dark', label: t('theme.dark') },
                  { value: 'gray', label: t('theme.gray') },
                  { value: 'light', label: t('theme.light') }
                ]}
                onValueChange={(v) => void update({ darkTheme: v })}
              />
            </Row>
          </Section>
        )}

        {tab === 'cache' && <CachePage />}

        {tab === 'debug' && (
          <Section title={t('settings.section.debug')}>
            <ToggleRow
              label={t('settings.debug_logging')}
              checked={settings.debugLoggingEnabled}
              onChange={(v) => void update({ debugLoggingEnabled: v })}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-tone-300">{t('settings.debug_logs')}</span>
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

            <div className="flex flex-col gap-1 text-xs text-tone-500">
              <LogSizeRow label={t('settings.log.conversion')} bytes={logSizes.conversion} />
              <LogSizeRow label={t('settings.log.error')} bytes={logSizes.error} />
              <LogSizeRow label={t('settings.log.debug')} bytes={logSizes.debug} />
            </div>
          </Section>
        )}

        {tab === 'updates' && (
          <Section title={t('settings.section.updates')}>
            <ToggleRow
              label={t('updates.automatic_updates')}
              checked={settings.autoCheckUpdates}
              onChange={(v) => void update({ autoCheckUpdates: v })}
              disabled={appInfo.platform !== 'darwin'}
            />
            <ToggleRow
              label={t('updates.automatic_download')}
              checked={settings.autoDownloadUpdates}
              onChange={(v) => void update({ autoDownloadUpdates: v })}
              disabled={appInfo.platform !== 'darwin'}
            />
            <div className="flex items-center justify-end">
              <Button
                variant="bordered"
                size="sm"
                disabled={appInfo.platform !== 'darwin'}
                onClick={() => void checkForUpdates()}
              >
                {t('updates.check_for_updates')}
              </Button>
            </div>
          </Section>
        )}

        {tab === 'about' && (
          <Section title={t('settings.section.about')}>
            <InfoRow label={t('settings.version')} value={version || '—'} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-tone-300">{t('settings.acknowledgements')}</span>
              <Button variant="bordered" size="sm" onClick={() => void ipc.invoke('licenses:open')}>
                {t('settings.view_licenses')}
              </Button>
            </div>
            {/* CC BY-SA 4.0 asks for attribution wherever the work is used,
              including an app's About screen. */}
            <p className="text-xs leading-relaxed text-tone-500">
              {t('settings.film_attribution')}{' '}
              <a
                className="underline hover:text-tone-300"
                href="https://github.com/andreavolpato/spektrafilm"
                target="_blank"
                rel="noreferrer"
              >
                github.com/andreavolpato/spektrafilm
              </a>
            </p>
          </Section>
        )}
      </div>
    </div>
  )
}

/**
 * The titlebar with the page title and the toolbar tabs. It has the window color
 * and a divider, as the main window toolbar has. The page scrolls under it.
 */
function SettingsTitlebar({
  tab,
  onSelect
}: {
  tab: Tab
  onSelect: (tab: Tab) => void
}): React.JSX.Element {
  return (
    // On macOS the native traffic lights sit on the top row. A bare drag region
    // takes only direct hits, so the title and the tab row carry it too.
    <header className="sticky top-0 z-10 border-b border-ink/10 bg-tone-950">
      {/* 32 px is the macOS titlebar height, so the title aligns with the traffic
          lights. The same padding on each side keeps the title centered. */}
      <div
        data-tauri-drag-region
        className={cn(
          'flex h-8 items-center justify-center',
          appInfo.platform === 'darwin' ? 'px-[78px]' : 'px-3'
        )}
      >
        <h1 data-tauri-drag-region className="truncate text-[13px] font-bold text-tone-100">
          {t(`settings.section.${tab}`)}
        </h1>
      </div>
      <div data-tauri-drag-region className="flex justify-center px-3 pb-2">
        {/* The selected tab is glass, and its lens refracts a copy of its icon and
            label. The gray accent is below 3:1 on the gray surface, so there the
            selected icon keeps the label color. */}
        <GlassGroup
          kind="tabs"
          id="settings"
          panelId={(value) => `settings-page-${value}`}
          display="stacked"
          glass
          aria-label={t('menu.file.settings')}
          value={tab}
          onValueChange={onSelect}
          items={TABS.map(([value, icon]) => ({
            value,
            icon,
            label: t(`settings.section.${value}`)
          }))}
          className="[&_[data-selected]>svg]:text-accent [html[data-theme=gray]_&_[data-selected]>svg]:text-inherit"
        />
      </div>
    </header>
  )
}

/** Decimal sizes, as `formatBytes` shows them. */
const CACHE_LIMITS = [256e6, 512e6, 1e9, 2e9, 5e9]

/** The disk cache of embedded previews and photo details. Edited photos have their own. */
function CachePage(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const [used, setUsed] = useState<number | null>(null)
  const [clearFailed, setClearFailed] = useState(false)
  const refresh = (): void => {
    void ipc.invoke('cache:size').then(setUsed, console.error)
  }
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  return (
    <Section title={t('settings.cache.title')}>
      <ToggleRow
        label={t('settings.cache.enabled')}
        help={t('settings.cache.enabled.help')}
        checked={settings.previewCacheEnabled}
        onChange={(v) => void update({ previewCacheEnabled: v })}
      />
      <Row label={t('settings.cache.limit')}>
        <Select
          aria-label={t('settings.cache.limit')}
          value={String(settings.previewCacheLimit)}
          options={CACHE_LIMITS.map((bytes) => ({
            value: String(bytes),
            label: formatBytes(bytes)
          }))}
          onValueChange={(v) => void update({ previewCacheLimit: Number(v) }).then(refresh)}
        />
      </Row>
      <Row label={t('settings.cache.used')}>
        <span className="text-sm text-tone-400">
          {used === null ? t('placeholder.dash') : formatBytes(used)}
        </span>
        <Button
          variant="bordered"
          size="sm"
          onClick={() => {
            setClearFailed(false)
            void ipc
              .invoke('cache:clear')
              .catch((error: unknown) => {
                console.error('Could not clear the preview cache', error)
                setClearFailed(true)
              })
              .then(refresh)
          }}
        >
          {t('settings.cache.clear')}
        </Button>
      </Row>
      {clearFailed && (
        <p role="alert" className="text-xs text-danger">
          {t('settings.cache.clear_failed')}
        </p>
      )}
    </Section>
  )
}

function InfoRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Row label={label}>
      <span className="text-sm text-tone-400">{value}</span>
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
