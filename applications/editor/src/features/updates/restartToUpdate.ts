import { Logger } from 'cleo'
import { confirmDialog } from '@cleo/app-kit/feedback/dialogStore'
import { toast } from '@cleo/app-kit/feedback/toastStore'
import { getUpdaterBridge } from '@cleo/app-kit/platform/desktopUpdater'
import { confirmDiscard, standDownUnloadGuard, whenSaveSettled } from '../unloadGuard'
import { drainProjectWrites, flushProjectWrites, runProjectUnloadHooks } from '../../utils/projectLifecycle'
import { stopWindowPlay } from '../playWindow/windowPlay'

/**
 * The Update button's Restart now: get the editor ready to be closed, then ask the shell to install the
 * downloaded update and restart into it (app-kit/desktop/desktopUpdater.js).
 *
 * Everything happens BEFORE the shell is asked, because electron-updater starts the installer before it quits the
 * app: an unload guard holding the quit up would leave the editor to be closed by the installer instead, work and
 * all. So: unsaved edits are asked about first, a save under way is waited for, Play stops, the project's waiting
 * writes run now and the running ones finish (a folder project's files among them), and only then do the guards
 * stand down. Nothing that fails along the way restarts anything.
 */
export async function restartToUpdate(): Promise<void> {
  const bridge = getUpdaterBridge()
  if (!bridge) return
  if (!(await confirmDiscard('Restarting to install the update'))) return

  if (!(await whenSaveSettled())) {
    const go = await confirmDialog({
      title: 'Still saving',
      message: 'A save has been running for 30 seconds. Restarting now may cut it off.',
      confirmLabel: 'Restart anyway', cancelLabel: 'Wait', tone: 'danger',
    })
    if (!go) return
  }

  await runProjectUnloadHooks()
  stopWindowPlay()
  flushProjectWrites()
  const drained = await drainProjectWrites()
  if (drained.timedOut) {
    const go = await confirmDialog({
      title: 'Still writing the project',
      message: 'Some of the project\'s writes were still running after 15 seconds. Restarting now may lose them.',
      confirmLabel: 'Restart anyway', cancelLabel: 'Wait', tone: 'danger',
    })
    if (!go) return
  }

  const reArm = standDownUnloadGuard()
  try {
    const result = await bridge.install()
    if (!result?.ok) throw new Error(result?.error || 'The update could not be installed.')
    Logger.info('Restarting to install the update', 'Editor')
  } catch (e: any) {
    reArm()
    const message = String(e?.message ?? e)
    Logger.error(`Update failed: ${message}`, 'Editor')
    toast.error(`The update could not be installed: ${message}`)
  }
}
