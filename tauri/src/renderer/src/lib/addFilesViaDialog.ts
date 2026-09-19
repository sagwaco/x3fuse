import { ipc } from './ipc'
import { useQueueStore } from '../stores/queueStore'

/** Open the native file picker and add any chosen X3F files to the queue. */
export async function addFilesViaDialog(): Promise<void> {
  const paths = await ipc.invoke('dialog:pickFiles')
  if (paths.length > 0) await useQueueStore.getState().addFiles(paths)
}
