// What the menus and the launcher do with folder projects.

import { Logger } from 'cleo'
import { activeProjectId } from '../../utils/projectScope'
import { loadProjects, wipeProject, type ProjectRecord } from '../../utils/projects'
import { switchProject, deleteProject } from '../projects/projectSwitch'
import { getEditorPrefs } from '../options/editorPrefs'
import { getProjectBridge, requireProjectBridge } from './desktopProject'
import { openFolderProject } from './openFolder'
import { folderSession } from './folderSession'
import { folderSink } from './folderSink'
import { clearExternalChanges } from './ProjectFolderProvider'

/** Read the open project's folder again, in place: what changed on disk replaces what the cache had. */
export async function reloadFolderProject(): Promise<boolean> {
  const pid = activeProjectId()
  if (!pid || !folderSession()) return false
  const ok = await switchProject({ to: pid, confirm: 'Reloading the project from its folder', title: 'Reloading from disk' })
  if (ok) { folderSink.clearConflicts(); clearExternalChanges() }
  return ok
}

/** Project ▸ Open Folder…: a folder holding project.cleo, opened in place. */
export async function openFolderDialog(): Promise<boolean> {
  const bridge = requireProjectBridge()
  const picked = await bridge.pickProject()
  if (!picked.ok) {
    if (!picked.canceled) Logger.error(String(picked.error ?? 'That folder is not a Cleo project'), 'Editor')
    return false
  }
  return openFolderProject(picked.root)
}

/** The open project's folder (or a file in it) in the system file manager. */
export async function showProjectFolder(rel?: string): Promise<void> {
  const s = folderSession()
  if (!s) return
  await getProjectBridge()?.reveal(s.root, rel)
}

/** The open project's folder in VS Code (or the editor chosen in Options ▸ Editor ▸ Scripts), at `rel:line`. */
export async function openProjectInCodeEditor(rel?: string, line?: number): Promise<boolean> {
  const s = folderSession()
  const bridge = getProjectBridge()
  if (!s || !bridge) return false
  // Pending writes first, so the IDE opens what the editor has.
  await folderSink.flushNow()
  const res = await bridge.launch(s.root, rel, getEditorPrefs().externalEditorCommand, line)
  if (!res.ok) Logger.error(`Could not open the project folder: ${res.error}`, 'Editor')
  return res.ok
}

/**
 * Remove a folder project from this machine's list: its cache is wiped; the folder stays unless
 * `trashFolder`, which moves it to the OS trash. The open project closes first.
 */
export async function removeFolderProject(record: ProjectRecord, opts: { trashFolder?: boolean } = {}): Promise<void> {
  const bridge = requireProjectBridge()
  const root = record.folder?.root
  if (record.id === activeProjectId()) await deleteProject(record.id, true)
  else await wipeProject(record.id)
  if (root) {
    if (opts.trashFolder) {
      const res = await bridge.trashFolder(root)
      if (!res.ok) Logger.error(`Could not move the folder to the trash: ${res.error}`, 'Editor')
    } else {
      await bridge.forget(root)
    }
  }
}

/** Folder records whose folder is gone, and the rest — for the launcher. */
export async function folderProjects(): Promise<{ record: ProjectRecord; missing: boolean }[]> {
  const bridge = getProjectBridge()
  const records = (await loadProjects()).filter(p => p.folder)
  if (!bridge) return records.map(record => ({ record, missing: false }))
  const out: { record: ProjectRecord; missing: boolean }[] = []
  for (const record of records) {
    const info = await bridge.inspect(record.folder!.root)
    out.push({ record, missing: !(info.ok && info.isProject) })
  }
  return out
}
