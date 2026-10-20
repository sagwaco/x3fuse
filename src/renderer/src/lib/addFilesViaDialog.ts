import { ipc } from './ipc'
import { useQueueStore } from '../stores/queueStore'

/** Open the native file picker and add any chosen X3F files to the queue. */
export async function addFilesViaDialog(): Promise<void> {
  const paths = await ipc.invoke('dialog:pickFiles')
  if (paths.length > 0) await useQueueStore.getState().addFiles(paths)
}

/** Open the native folder picker and add the X3F files of the chosen folders. */
export async function addFolderViaDialog(): Promise<void> {
  const paths = await ipc.invoke('dialog:pickFolder')
  if (paths.length > 0) await useQueueStore.getState().addFiles(paths)
}
