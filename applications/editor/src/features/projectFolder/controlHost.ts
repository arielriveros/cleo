// The editor's side of the project's `cleo` CLI (`npm run play`, `npm run debug`; app-kit/desktop/controlPipe.js
// relays them). Installed once at boot, so the launcher answers too:
//
//   ping            which project folder is open
//   open { root }   open that project (asking about unsaved work, as any switch does)
//   play { root }   open it if it is not the open one, then Play in window — with VS Code debugging on for the
//                   session when `debug`. Answered once the game window is starting (`port`: the debug port).
//
// A play for a project that is still opening waits for it: the open project's link (ProjectFolderProvider)
// registers the starter once the project has loaded, and takes the plays waiting for its folder.

import { Logger } from 'cleo'
import { getControlBridge, type ControlCommand } from './desktopProject'
import { folderSession } from './folderSession'
import { openFolderProject } from './openFolder'

export type PlayResult = { ok: boolean; port?: number; error?: string }
type PlayStarter = (debug: boolean) => Promise<PlayResult>

interface WaitingPlay { root: string; debug: boolean; done?: (result: PlayResult) => void }

let starter: PlayStarter | null = null
let starterRoot: string | null = null
const waiting: WaitingPlay[] = []

const sameRoot = (a?: string | null, b?: string | null) => !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

/** The open, loaded project can play: run what waited for it. Returns the unregister. */
export function setPlayStarter(root: string, fn: PlayStarter): () => void {
  starter = fn
  starterRoot = root
  for (const w of waiting.splice(0)) {
    if (sameRoot(w.root, root)) void fn(w.debug).then(r => w.done?.(r))
    else waiting.push(w)
  }
  return () => { if (starter === fn) { starter = null; starterRoot = null } }
}

/** A play to run once `root` is open and loaded (a launch's `--cleo-play`, or the CLI's play). */
export function queuePlay(root: string, debug: boolean, done?: (result: PlayResult) => void): void {
  if (starter && sameRoot(starterRoot, root)) { void starter(debug).then(r => done?.(r)); return }
  waiting.push({ root, debug, done })
}

let installed = false

export function installControlHost(): void {
  const control = getControlBridge()
  if (!control || installed) return
  installed = true
  control.onCommand(command => { void handle(command).then(result => control.reply(command.id, result as any)) })
  void control.ready()
}

async function handle(command: ControlCommand): Promise<Record<string, unknown>> {
  try {
    const open = folderSession()?.root ?? null
    if (command.cmd === 'ping') return { ok: true, root: open }
    if (!command.root) return { ok: false, error: 'no project folder named' }
    if (command.cmd === 'open') {
      if (sameRoot(open, command.root)) return { ok: true }
      return { ok: await openFolderProject(command.root, { confirm: 'Opening another project' }) }
    }
    // play
    const result = new Promise<PlayResult>(resolve => queuePlay(command.root!, !!command.debug, resolve))
    if (!sameRoot(open, command.root)) {
      const opened = await openFolderProject(command.root, { confirm: 'Opening another project' })
      if (!opened) {
        const i = waiting.findIndex(w => sameRoot(w.root, command.root))
        if (i >= 0) waiting.splice(i, 1)
        return { ok: false, error: 'the project was not opened (unsaved work was kept)' }
      }
    }
    // Answered when the game starts, or after two minutes of a project that never finished opening.
    return await Promise.race([result, new Promise<PlayResult>(r => setTimeout(() => r({ ok: false, error: 'the project did not finish opening' }), 120_000))])
  } catch (e) {
    Logger.error(`A command from the project's cleo tool failed: ${(e as Error)?.message ?? e}`, 'Editor')
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}
