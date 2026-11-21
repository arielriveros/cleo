import { Logger } from 'cleo'
import { beginLoad, continueLoad, type LoadHandle } from '@cleo/app-kit/feedback/loadingStore'
import { setProjectTypes } from '@cleo/app-kit/code/projectTypes'
import {
  activateProject, clearPendingDelete, createProject, foldersOnly, loadProjects, nextProjectAfterDelete, parkPendingDelete, wipeProject,
  type NewProjectOptions, type ProjectRecord,
} from '../../utils/projects'
import { activeProjectId } from '../../utils/projectScope'
import {
  cancelProjectWrites, drainProjectWrites, flushProjectWrites, resetProjectState, runProjectUnloadHooks,
} from '../../utils/projectLifecycle'
import { confirmDiscard, reloadDiscarding, setUnsavedWork } from '../unloadGuard'
import { beginSwitchLoad } from '../loading/bootLoad'
import { resetEngineProjectState } from '../editorEngine'
import { stopWindowPlay } from '../playWindow/windowPlay'

// Opening another project in the running editor. The window, the engine, its graphics device and its compiled
// shaders stay; the project's providers unmount, what the closed project left in the engine and in the
// editor's modules is dropped, and the next project mounts and loads as a startup does, minus the device and
// the shaders. Every route that opens a project comes here: the browser's Open, a new project, installing an
// example, importing a bundle (as a new project, over the open one, merged into it), deleting the open one.
//
// The order is what keeps one project's data out of another's keys (utils/projectLifecycle.ts):
//   confirm → the loading screen → stop Play → flush (or, deleting, drop) the waiting writes → unmount →
//   drain the writes under way → reset the engine and the modules → [create the next project] →
//   [wipe the deleted one] → [prepare: an import's writes] → activate the next → mount it.
// Nothing changes before the unmount, so a switch that fails before it leaves the editor as it was.

/** What app.tsx does for a switch: the providers in and out of the page, and the screens it falls back to. */
export interface ProjectHost {
  /** Take the open project's providers out of the page. Resolves once their cleanups have run. */
  unmount(): Promise<void>
  /** Mount the open project's providers afresh. */
  mount(): void
  /** No project to open: the launcher. */
  showLauncher(): Promise<void>
  /** The switch could not finish: say so, offering the launcher and a reload. */
  showFailure(message: string): void
}

let host: ProjectHost | null = null

/**
 * Reading a folder project's folder into its cache (features/projectFolder/openFolder.ts), registered by that
 * module so this one does not import it. Runs after the closed project is gone and before the next mounts.
 */
type FolderSync = (pid: string, root: string, load: LoadHandle) => Promise<void>
let folderSync: FolderSync | null = null
export function registerFolderSync(fn: FolderSync): void {
  folderSync = fn
}

/** app.tsx, once mounted. Returns the unregister. */
export function registerProjectHost(next: ProjectHost): () => void {
  host = next
  return () => { if (host === next) host = null }
}

export interface SwitchRequest {
  /**
   * The project to open, or one to create first (after the confirm, so a declined switch creates nothing).
   * Null: close the open project and show the launcher (the desktop, deleting the last folder project).
   */
  to: string | { create: { name: string; options?: NewProjectOptions } } | null
  /** Ask about unsaved work first, completing "<confirm> discards these unsaved edits." Null: asked already. */
  confirm?: string | null
  /** The open project, to wipe once it is closed (deleting it). Its waiting writes are dropped, not flushed. */
  deleting?: string
  /** Writes to make once the open project is closed and before the next opens: an import's. */
  prepare?: () => Promise<void>
  /** The loading screen's title. Default "Opening <name>", or the title of a load already on screen. */
  title?: string
}

let inFlight = false

/** Whether a switch is under way (a second one is refused). */
export function isSwitchingProject(): boolean {
  return inFlight
}

/**
 * Open another project in place. Returns false when nothing happened: the user kept their unsaved edits, or
 * another switch was already under way.
 */
export async function switchProject(req: SwitchRequest): Promise<boolean> {
  if (inFlight) { Logger.warn('A project is already opening', 'Editor'); return false }
  if (req.confirm && !(await confirmDiscard(req.confirm))) return false
  inFlight = true
  const from = activeProjectId()
  const projects = await loadProjects()
  const nameOf = (id: string) => projects.find(p => p.id === id)?.name ?? 'project'
  const targetName = req.to === null ? 'the project list' : typeof req.to === 'string' ? nameOf(req.to) : req.to.create.name
  const onScreen = continueLoad()
  const title = req.title ?? `Opening ${targetName}`

  try {
    // No host (a test, or a page that is not the editor): the old way, a reload into the project.
    if (!host) {
      if (req.to === null) { if (req.deleting) parkPendingDelete(req.deleting); reloadDiscarding(); return true }
      const target = typeof req.to === 'string' ? req.to : (await createProject(req.to.create.name, req.to.create.options)).id
      if (req.deleting) parkPendingDelete(req.deleting)
      await activateProject(target)
      reloadDiscarding()
      return true
    }

    // The screen goes up first and stays up: what follows takes the editor out of the page. A load already
    // on screen (an example's download, an import's writes) carries on.
    const load = onScreen ?? beginLoad(title, [])
    load.addSteps([{ id: 'unload', label: from ? `Closing ${nameOf(from)}` : 'Closing', weight: 1 }])
    const unload = load.step('unload').start()
    const timing: [string, number][] = []
    let mark = performance.now()
    const lap = (what: string) => { const now = performance.now(); timing.push([what, Math.round(now - mark)]); mark = now }

    // A crash from here on must not leave the deleted project behind: the next boot wipes what is parked.
    if (req.deleting) parkPendingDelete(req.deleting)
    await runProjectUnloadHooks()
    stopWindowPlay()
    lap('stop')
    // The waiting writes land in the project they were made in; a project being deleted gets none.
    if (req.deleting) cancelProjectWrites(); else flushProjectWrites()
    await host.unmount()
    lap('unmount')
    const drained = await drainProjectWrites()
    lap('drain')
    if (drained.timedOut) Logger.warn('Some of the closed project\'s writes were still running after 15 s', 'Editor')
    await resetEngineProjectState()
    await resetProjectState()
    setProjectTypes('')
    setUnsavedWork([])
    lap('reset')
    unload.done()

    let target: string | null
    try {
      target = req.to === null ? null : typeof req.to === 'string' ? req.to : (await createProject(req.to.create.name, req.to.create.options)).id
      if (req.deleting) {
        await wipeProject(req.deleting)
        // A write still running could put a key back: then the next boot sweeps it again.
        if (!drained.timedOut) clearPendingDelete(req.deleting)
        Logger.info(`Deleted "${nameOf(req.deleting)}"`, 'Editor')
      }
      await req.prepare?.()
      if (target === null) { await host.showLauncher(); return true }
      // A folder project: the folder is the truth, so it is read into the cache before anything mounts.
      const record = (await loadProjects()).find(p => p.id === target)
      if (record?.folder) {
        if (!folderSync) throw new Error('Folder projects are not available here')
        load.addSteps([{ id: 'folder', label: 'Reading the project folder', weight: 2 }])
        await folderSync(target, record.folder.root, load)
      }
    } catch (e) {
      await recover(from, req.deleting, `Could not open ${targetName}: ${(e as Error)?.message ?? e}`)
      return true
    }

    await activateProject(target)
    beginSwitchLoad(title, !!onScreen && !req.title)
    host.mount()
    Logger.info(`Opened "${typeof req.to === 'string' ? nameOf(target) : targetName}" (closing the last one: ${timing.map(([w, ms]) => `${w} ${ms} ms`).join(', ')})`, 'Editor')
    return true
  } catch (e) {
    const message = `Opening ${targetName} failed: ${(e as Error)?.message ?? e}`
    Logger.error(message, 'Editor')
    host?.showFailure(message)
    return true
  } finally {
    inFlight = false
  }
}

/** A switch that failed after the old project closed: open it again if it is still there, else the newest, else the launcher. */
async function recover(from: string, deleted: string | undefined, message: string): Promise<void> {
  Logger.error(message, 'Editor')
  const projects = await loadProjects()
  // A folder project cannot be put back by remounting: its folder was closed. The launcher says why.
  const back = foldersOnly() ? undefined : from && from !== deleted && projects.some(p => p.id === from)
    ? from
    : [...projects].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id
  if (!back) { lastFailure = message; await host?.showLauncher(); return }
  await activateProject(back)
  beginSwitchLoad(`Opening ${projects.find(p => p.id === back)?.name ?? 'project'}`)
  host?.mount()
}

let lastFailure: string | null = null
/** Why the last switch ended on the launcher, once (the launcher shows it). */
export function takeSwitchFailure(): string | null {
  const m = lastFailure
  lastFailure = null
  return m
}

/** Open a project from the browser: asks about unsaved work. False when the user backed out. */
export function openProject(id: string): Promise<boolean> {
  return switchProject({ to: id, confirm: 'Opening another project' })
}

/**
 * Open the open project again, after `prepare` has rewritten its storage with no writer of its own running: a
 * bundle imported over it, or merged into it. Asks nothing: the caller already did.
 */
export function reopenProject(options: { prepare: () => Promise<void>; title?: string }): Promise<boolean> {
  return switchProject({ to: activeProjectId(), confirm: null, prepare: options.prepare, title: options.title })
}

/**
 * Delete a project. One that is not open is wiped now; the open one is closed first, and the next most recent
 * project opens (a new empty one when it was the last). The caller has confirmed, unsaved edits included.
 */
export async function deleteProject(id: string, isActive: boolean): Promise<void> {
  if (!isActive) {
    await wipeProject(id)
    return
  }
  const next: ProjectRecord | null = await nextProjectAfterDelete(id)
  // The desktop never makes an IndexedDB-only project: with no folder project left, the launcher opens.
  const fallback = foldersOnly() ? null : { create: { name: 'Untitled Project' } }
  await switchProject({ to: next ? next.id : fallback, deleting: id, confirm: null })
}
