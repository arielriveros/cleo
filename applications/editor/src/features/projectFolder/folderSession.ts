// The open folder project, as module state: which folder, what the editor and the disk last agreed on, and
// the changes the main process reported that nobody has handled yet.
//
// Module state rather than React state because it outlives the providers on both ends: it is set up before
// they mount (the open reads the folder into the cache first) and torn down after they unmount (a project
// switch closes the folder only once every write under way has drained).

import { Logger } from 'cleo'
import { idbGet, idbSet } from '@cleo/app-kit/utils/idb'
import { folderPendingKey, folderStateKey } from '../../utils/storageKeys'
import { onProjectClose } from '../../utils/projectLifecycle'
import type { CachedFile } from '../../utils/folder/folderDelta'
import type { ProjectFile } from '../../utils/folder/projectCodec'
import type { AssetKind } from '../../utils/vfs'
import { getProjectBridge, type FolderChange } from './desktopProject'

export interface FolderSession {
  pid: string
  root: string
  /** rel -> what the cache and the disk agree the file is. The editor's view of the folder. */
  state: Map<string, CachedFile>
  /** Blob digests present in the folder. */
  blobs: Set<string>
  /** Folders under the data dirs that exist (rels). */
  dirs: Set<string>
  /** Files the editor could not read: never overwritten until they read again. */
  blocked: Map<string, { reason: string; message: string }>
  /** What project.cleo says (its uid is the project's own; it never changes). */
  project: ProjectFile
}

let session: FolderSession | null = null
let unsubscribe: (() => void) | null = null
const pendingChanges: FolderChange[] = []
const listeners = new Set<() => void>()

export function folderSession(): FolderSession | null {
  return session
}

/** Begin the session for an opened folder: from here on the main process's reports are queued for it. */
export function beginFolderSession(next: FolderSession): void {
  endFolderSession()
  session = next
  const bridge = getProjectBridge()
  unsubscribe = bridge?.onChange(({ root, change }) => {
    if (!session || !sameRoot(root, session.root)) return
    pendingChanges.push(change)
    for (const fn of listeners) fn()
  }) ?? null
}

function endFolderSession(): void {
  unsubscribe?.()
  unsubscribe = null
  session = null
  pendingChanges.length = 0
}

/** Take every reported change not handled yet. */
export function takeFolderChanges(): FolderChange[] {
  return pendingChanges.splice(0)
}

export function onFolderChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

const sameRoot = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

// A project switch closes the folder (and gives up its lock) once the closed project's writes have drained.
onProjectClose(async () => {
  const closing = session
  endFolderSession()
  if (!closing) return
  try {
    await saveFolderState(closing.pid, closing.state)
    await getProjectBridge()?.close(closing.root)
  } catch (e) {
    Logger.warn(`Could not close the project folder: ${e}`, 'Editor')
  }
})

// ---------------------------------------------------------------------------------------------------
// The cache state and the write journal, in IndexedDB
// ---------------------------------------------------------------------------------------------------

interface StoredState { version: 1; files: Record<string, CachedFile> }

export async function loadFolderState(pid: string): Promise<Map<string, CachedFile>> {
  try {
    const stored = await idbGet<StoredState>(folderStateKey(pid))
    if (stored?.version === 1 && stored.files) return new Map(Object.entries(stored.files))
  } catch { /* none */ }
  return new Map()
}

export async function saveFolderState(pid: string, state: Map<string, CachedFile>): Promise<void> {
  const files: Record<string, CachedFile> = {}
  for (const [rel, f] of state) files[rel] = f
  await idbSet(folderStateKey(pid), { version: 1, files } satisfies StoredState)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** Persist the open session's state soon (it changes on every write the folder confirms). */
export function scheduleStateSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const s = session
    if (s) void saveFolderState(s.pid, s.state).catch(e => Logger.warn(`Could not save the folder state: ${e}`, 'Editor'))
  }, 500)
}

/** (kind, guid) pairs written into the cache whose files the folder has not confirmed yet. */
export async function loadJournal(pid: string): Promise<Set<string>> {
  try { return new Set((await idbGet<string[]>(folderPendingKey(pid))) ?? []) } catch { return new Set() }
}

export async function saveJournal(pid: string, keys: Set<string>): Promise<void> {
  await idbSet(folderPendingKey(pid), [...keys])
}

export const journalKey = (kind: AssetKind | 'scene', guid: string) => `${kind}:${guid}`
