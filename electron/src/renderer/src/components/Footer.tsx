import { Plus, Settings } from 'lucide-react'
import { ipc } from '../lib/ipc'
import { useSettingsStore } from '../stores/settingsStore'
import { addFilesViaDialog } from '../lib/addFilesViaDialog'
import { basename } from '../lib/path'
import { t } from '../lib/strings'
import { Button } from './ui/button'

/** Footer: add files · output-directory display/picker · settings (port of ContentView footer). */
export function Footer(): React.JSX.Element {
  const outputDirectory = useSettingsStore((s) => s.settings.outputDirectory)
  const update = useSettingsStore((s) => s.update)

  const display = outputDirectory ? basename(outputDirectory) : t('footer.alongside_original')

  async function pickOutputDir(): Promise<void> {
    const dir = await ipc.invoke('dialog:pickOutputDir')
    if (dir) await update({ outputDirectory: dir })
  }

  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-t border-white/10 px-4">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void addFilesViaDialog()}
        title={t('button.add_files')}
      >
        <Plus className="h-4 w-4" />
      </Button>

      <button
        type="button"
        onClick={() => void pickOutputDir()}
        title={outputDirectory ?? t('footer.alongside_original')}
        className="flex max-w-[60%] flex-col items-center leading-tight"
      >
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">
          {t('footer.output_directory')}
        </span>
        <span className="max-w-full truncate text-xs text-neutral-400">{display}</span>
      </button>

      <Button
        variant="ghost"
        size="icon"
        onClick={() => void ipc.invoke('window:openSettings')}
        title={t('button.settings')}
      >
        <Settings className="h-4 w-4" />
      </Button>
    </div>
  )
}
