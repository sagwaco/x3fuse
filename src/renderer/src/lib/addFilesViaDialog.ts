import { ipc } from './ipc'
import { useQueueStore } from '../stores/queueStore'

/** Opens a native picker and adds the X3F files that it gives to the queue. */
async function addFrom(channel: 'dialog:pickFiles' | 'dialog:pickFolder'): Promise<void> {
  try {
    const paths = await ipc.invoke(channel)
    if (paths.length > 0) await useQueueStore.getState().addFiles(paths)
  } catch (error) {
    // The backend shows and logs why it could not give the files.
    console.error('Could not add photos', error)
  }
}

/** Open the native file picker and add any chosen X3F files to the queue. */
export const addFilesViaDialog = (): Promise<void> => addFrom('dialog:pickFiles')

/** Open the native folder picker and add the X3F files of the chosen folders. */
export const addFolderViaDialog = (): Promise<void> => addFrom('dialog:pickFolder')
