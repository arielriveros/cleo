// Opening, creating and installing folder projects (the desktop app, where every project is a folder).
//
// Opening a folder never trusts the cache: the main process lists every file with its content hash, and
// what differs from the cache state is read and written into the cache before the editor mounts. On an
// unchanged folder that is a stat walk and nothing else; on a fresh clone it is a full read.

import { Logger } from 'cleo'
import { continueLoad, type LoadHandle } from '@cleo/app-kit/feedback/loadingStore'
import { cryptoRandomId } from '../../utils/ids'
import { ensureFolderRecord, recordOfFolder, renameProject, type NewProjectOptions } from '../../utils/projects'
import type { BundleData } from '../../utils/bundle'
import { readAssetJson } from '../../utils/folder/codec'
import { filesToRead, readFolderDelta, type CachedFile, type FolderDelta } from '../../utils/folder/folderDelta'
import { bundleToFolder, FOLDER_FORMAT, parseProjectFile, projectFileText, type FolderSnapshot } from '../../utils/folder/projectCodec'
import { ASSETS_DIR, PROJECT_FILE, SETTINGS_REL, kindOfFileName, metaRelOf, nameOfRel, roleOfRel } from '../../utils/folder/layout'
import { parseMeta } from '../../utils/folder/meta'
import { isRawByteKind } from '../../utils/vfs'
import { toJsonText } from '../../utils/folder/jsonText'
import { registerFolderSync, switchProject } from '../projects/projectSwitch'
import { getProjectBridge, requireProjectBridge, MAX_BATCH_BYTES, type FileStat, type FolderBatch } from './desktopProject'
import { beginFolderSession, loadFolderState, loadJournal, saveFolderState, saveJournal } from './folderSession'
import { idbGet } from '@cleo/app-kit/utils/idb'
import { sceneKey } from '../../utils/storageKeys'
import { writeDeltaIntoCache } from './ingest'
import { writeProjectScaffold } from './scaffold'

/** Files already in memory for a folder just written (an example install), so the open need not read them back. */
export interface Preloaded { files: Map<string, string | Uint8Array>; blobs: Map<string, Uint8Array> }

export interface SyncReport {
  cold: boolean
  unchanged: boolean
  upserts: number
  removed: number
  blocked: { rel: string; message: string }[]
  name?: string
}

const toBytes = (c: string | Uint8Array) => (typeof c === 'string' ? new TextEncoder().encode(c) : c)

/** Read rels in batches that keep one IPC message under the size cap. */
async function readAll(root: string, rels: string[], sizes: Map<string, number>, onDone?: (n: number) => void): Promise<Map<string, Uint8Array>> {
  const bridge = requireProjectBridge()
  const out = new Map<string, Uint8Array>()
  let batch: string[] = []
  let bytes = 0
  const flush = async () => {
    if (!batch.length) return
    const res = await bridge.read(root, batch)
    if (!res.ok) throw new Error(res.error || 'Could not read the project folder')
    for (const f of res.files) if (f.data) out.set(f.rel, f.data)
    onDone?.(out.size)
    batch = []; bytes = 0
  }
  for (const rel of rels) {
    const size = sizes.get(rel) ?? 0
    if (batch.length && (bytes + size > MAX_BATCH_BYTES || batch.length >= 500)) await flush()
    batch.push(rel); bytes += size
  }
  await flush()
  return out
}

async function readBlobs(root: string, hashes: string[]): Promise<Map<string, Uint8Array>> {
  const bridge = requireProjectBridge()
  const out = new Map<string, Uint8Array>()
  for (let i = 0; i < hashes.length; i += 200) {
    const res = await bridge.readBlobs(root, hashes.slice(i, i + 200))
    if (!res.ok) throw new Error(res.error || 'Could not read the project folder')
    for (const b of res.blobs) if (b.data) out.set(b.hash, b.data)
  }
  return out
}

/**
 * Bring project `pid`'s cache in line with its folder. Runs before the project's providers mount (at boot
 * and in a project switch). Leaves the folder open, locked and watched, as the session of the project.
 */
export async function syncCacheFromFolder(pid: string, root: string, load?: LoadHandle | null, preloaded?: Preloaded): Promise<SyncReport> {
  const bridge = requireProjectBridge()
  const step = load?.step('folder')
  step?.start('Reading the project folder')

  const opened = await bridge.open(root)
  if (!opened.ok) {
    const locked = (opened as any).locked
    throw new Error(locked ? `The project is open in another Cleo (process ${locked.pid})` : (opened.error || 'Could not open the project folder'))
  }
  const listing = opened.files.map(f => ({ rel: f.rel, sha: f.sha, mtimeMs: f.mtimeMs, size: f.size }))
  const sizes = new Map(opened.files.map(f => [f.rel, f.size]))
  const previous = await loadFolderState(pid)
  const cold = previous.size === 0

  const wanted = filesToRead(listing, previous)
  // project.cleo is always read: it is small, and the session needs what it says (the project's uid).
  if (listing.some(f => f.rel === PROJECT_FILE) && !wanted.includes(PROJECT_FILE)) wanted.push(PROJECT_FILE)
  const read = new Map<string, string | Uint8Array>()
  const fromDisk: string[] = []
  for (const rel of wanted) {
    const mem = preloaded?.files.get(rel)
    if (mem !== undefined) read.set(rel, mem); else fromDisk.push(rel)
  }
  if (fromDisk.length) {
    const got = await readAll(root, fromDisk, sizes, n => step?.progress(n, fromDisk.length, 'Reading files'))
    for (const [rel, data] of got) read.set(rel, data)
  }

  // The blobs the JSON files that changed reference.
  const needed = new Set<string>()
  for (const [rel, content] of read) {
    const role = roleOfRel(rel)
    if (role !== 'asset' && role !== 'derived') continue
    const kind = kindOfFileName(nameOfRel(rel))
    if (kind && (isRawByteKind(kind) || kind === 'script')) continue
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
    if (!text.trimStart().startsWith('{')) continue
    const json = readAssetJson(text)
    if (json.ok) for (const h of json.refs) needed.add(h)
  }
  const blobs = new Map<string, Uint8Array>()
  const missing: string[] = []
  for (const h of needed) { const mem = preloaded?.blobs.get(h); if (mem) blobs.set(h, mem); else missing.push(h) }
  if (missing.length) for (const [h, b] of await readBlobs(root, missing)) blobs.set(h, b)

  step?.progress(1, 1, 'Updating the cache')
  const delta = await readFolderDelta({ listing, dirs: opened.dirs, previous, read, getBlob: h => blobs.get(h) })
  await keepUnflushedScenes(pid, opened.root, delta, previous)
  const ingested = delta.unchanged && !cold ? null : await writeDeltaIntoCache(pid, delta, { cold })

  // Write back what the read found missing or wrong (metas, re-minted ids, textures minted for dropped images).
  const state = delta.next
  const fixes = new Map([...delta.fixes, ...(ingested?.fixes ?? [])])
  if (fixes.size) {
    const res = await bridge.apply(root, { writes: [...fixes].map(([rel, data]) => ({ rel, data })) })
    for (const [rel, stat] of Object.entries(res.stats)) {
      if (!stat) continue
      const prev = state.get(rel)
      // A file the fixes created (a texture minted for a dropped image) is an asset the state did not have:
      // its identity is in the meta written with it.
      let identity: Partial<CachedFile> = {}
      if (!prev?.kind && roleOfRel(rel) === 'asset') {
        const meta = fixes.get(metaRelOf(rel))
        const parsed = meta ? parseMeta(meta) : null
        if (parsed?.ok) identity = { kind: parsed.meta.kind, guid: parsed.meta.guid, created: parsed.meta.created, refs: [] }
      }
      state.set(rel, { ...(prev ?? {}), ...identity, sha: stat.sha })
    }
    if (!res.ok) Logger.warn(`Could not write ${res.errors.length} fix(es) to the project folder: ${res.errors[0]?.error}`, 'Editor')
  }
  await saveFolderState(pid, state)

  const project = delta.project ?? { cleo: 1, format: FOLDER_FORMAT, uid: cryptoRandomId(), name: 'Project' }
  beginFolderSession({
    pid, root: opened.root, state, blobs: new Set(opened.blobs), dirs: new Set(opened.dirs),
    blocked: new Map(delta.blocked.map(b => [b.rel, { reason: b.reason, message: b.message }])),
    project,
  })
  if (delta.project?.name) await renameProject(pid, delta.project.name)

  const report: SyncReport = {
    cold, unchanged: delta.unchanged, upserts: delta.upserts.length, removed: delta.removed.length,
    blocked: delta.blocked.map(b => ({ rel: b.rel, message: b.message })), name: delta.project?.name,
  }
  step?.done(cold ? `${report.upserts} assets` : report.unchanged ? 'up to date' : `${report.upserts} changed, ${report.removed} removed`)
  return report
}

/**
 * The journal's other half. A scene saved into the cache whose file the folder never confirmed (the editor
 * stopped between the two writes) is pushed by the next session, when its file is still what it was. When
 * the file changed on disk meanwhile too, the disk wins — and the cache's version, about to be replaced, is
 * kept in `.cleo/recovered/<time>/` rather than lost, with a line in the log saying where.
 */
async function keepUnflushedScenes(pid: string, root: string, delta: FolderDelta, previous: Map<string, CachedFile>): Promise<void> {
  const journal = await loadJournal(pid)
  if (!journal.size) return
  const replaced = new Set([...delta.upserts.filter(u => u.kind === 'scene').map(u => u.guid), ...delta.removed.filter(r => r.kind === 'scene').map(r => r.guid)])
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let kept = 0
  for (const key of [...journal]) {
    const [kind, guid] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    if (kind !== 'scene' || !replaced.has(guid)) continue
    const data = await idbGet(sceneKey(guid, pid))
    const rel = [...previous].find(([, f]) => f.kind === 'scene' && f.guid === guid)?.[0] ?? `${guid}.scene`
    if (data) {
      const res = await requireProjectBridge().writeScaffold(root, [{ rel: `.cleo/recovered/${stamp}/${nameOfRel(rel)}.json`, content: JSON.stringify(data) }])
      if (res.ok) { kept++; Logger.warn(`${rel} changed on disk while the editor's last save of it had not reached the folder; that save is kept in .cleo/recovered/${stamp}/`, 'Editor') }
    }
    journal.delete(key)
  }
  if (kept || journal.size) await saveJournal(pid, journal)
}

/** What a folder's project.cleo says, or an error to show. */
export async function readProjectFile(root: string): Promise<{ ok: true; name: string; uid: string } | { ok: false; error: string }> {
  const info = await requireProjectBridge().inspect(root)
  if (!info.ok) return { ok: false, error: info.error || 'Could not read that folder' }
  if (!info.isProject || !info.project) return { ok: false, error: 'That folder has no project.cleo' }
  const parsed = parseProjectFile(info.project)
  if (!parsed.ok) return { ok: false, error: parsed.message }
  return { ok: true, name: parsed.file.name, uid: parsed.file.uid }
}

/** Open the project in `root` in place (the switch asks about unsaved work unless `confirm` is null). */
export async function openFolderProject(root: string, opts: { confirm?: string | null; title?: string; preloaded?: Preloaded } = {}): Promise<boolean> {
  const file = await readProjectFile(root)
  if (!file.ok) { Logger.error(`Could not open ${root}: ${file.error}`, 'Editor'); return false }
  const record = await ensureFolderRecord(root, file.name, file.uid)
  await requireProjectBridge().remember(root, file.name)
  if (opts.preloaded) pendingPreload.set(record.id, opts.preloaded)
  return switchProject({ to: record.id, confirm: opts.confirm === undefined ? 'Opening another project' : opts.confirm, title: opts.title ?? `Opening ${file.name}` })
}

/** Files an install already holds in memory, handed to the sync of the project it is opening. */
const pendingPreload = new Map<string, Preloaded>()
export function takePreloaded(pid: string): Preloaded | undefined {
  const p = pendingPreload.get(pid)
  pendingPreload.delete(pid)
  return p
}

/**
 * Write a whole folder snapshot (a new project, an installed example, an imported bundle) into `root`,
 * which must be prepared (empty, or not yet a project). Blobs go first, so no file ever references a blob
 * that is not there. Returns the sha of every file written.
 */
export async function writeSnapshot(root: string, snapshot: FolderSnapshot, onProgress?: (done: number, total: number) => void): Promise<Map<string, FileStat>> {
  const bridge = requireProjectBridge()
  const opened = await bridge.open(root, { allowNew: true })
  if (!opened.ok) throw new Error(opened.error || 'Could not open the new project folder')
  const stats = new Map<string, FileStat>()
  const total = snapshot.blobs.size + snapshot.files.size
  let done = 0
  try {
    const send = async (batch: FolderBatch, n: number) => {
      const res = await bridge.apply(opened.root, batch)
      if (!res.ok) throw new Error(res.errors[0]?.error || res.error || 'Could not write the project folder')
      for (const [rel, s] of Object.entries(res.stats)) if (s) stats.set(rel, { rel, ...s })
      done += n
      onProgress?.(done, total)
    }
    let blobs: FolderBatch['blobs'] = []
    let bytes = 0
    for (const [hash, data] of snapshot.blobs) {
      if (blobs.length && bytes + data.byteLength > MAX_BATCH_BYTES) { await send({ blobs }, blobs.length); blobs = []; bytes = 0 }
      blobs.push({ hash, data }); bytes += data.byteLength
    }
    if (blobs.length) await send({ blobs }, blobs.length)
    await send({ mkdirs: snapshot.dirs.filter(d => d.startsWith(ASSETS_DIR)) }, 0)
    let writes: NonNullable<FolderBatch['writes']> = []
    bytes = 0
    // project.cleo last: a folder is a project only once everything it names is there.
    const entries = [...snapshot.files].sort(([a], [b]) => (a === PROJECT_FILE ? 1 : b === PROJECT_FILE ? -1 : 0))
    for (const [rel, data] of entries) {
      const size = toBytes(data).byteLength
      if (writes.length && (bytes + size > MAX_BATCH_BYTES || writes.length >= 500)) { await send({ writes }, writes.length); writes = []; bytes = 0 }
      writes.push({ rel, data, expect: null }); bytes += size
    }
    if (writes.length) await send({ writes }, writes.length)
  } finally {
    await bridge.close(opened.root)
  }
  return stats
}

/** Prepare `root` for a new project, or say why not. */
async function prepare(root: string): Promise<string> {
  const res = await requireProjectBridge().prepareNew(root)
  if (!res.ok) throw new Error(res.error || 'That folder cannot hold a new project')
  return res.root
}

export interface FolderProjectOptions extends NewProjectOptions {
  gitInit?: boolean
  npmInstall?: boolean
}

/** Create a new, empty folder project in `root` and open it. */
export async function createFolderProject(rootIn: string, name: string, options: FolderProjectOptions = {}): Promise<boolean> {
  const root = await prepare(rootIn)
  const uid = cryptoRandomId()
  const files = new Map<string, string | Uint8Array>()
  files.set(PROJECT_FILE, projectFileText({ cleo: 1, format: FOLDER_FORMAT, uid, name, ...(options.dimension ? { prefs: { dimension: options.dimension } } : {}) }))
  if (options.settings) files.set(SETTINGS_REL, toJsonText(options.settings))
  await writeSnapshot(root, { files, dirs: [ASSETS_DIR, `${ASSETS_DIR}/Scenes`], blobs: new Map() })
  await finishNewFolder(root, name, options)
  return openFolderProject(root, { confirm: null, title: `Opening ${name}` })
}

/** The tooling around a new folder: the scaffold, a git repository, the npm install — none of them fatal. */
async function finishNewFolder(root: string, name: string, options: FolderProjectOptions): Promise<void> {
  const bridge = requireProjectBridge()
  try { await writeProjectScaffold(root, name) } catch (e) { Logger.warn(`Could not write the project's tooling files: ${e}`, 'Editor') }
  if (options.gitInit) {
    const res = await bridge.gitInit(root)
    if (!res.ok) Logger.warn(`git init: ${res.error}`, 'Editor')
  }
  if (options.npmInstall) {
    // In the background: the project opens meanwhile, and only script tooling waits on it.
    void bridge.npmInstall(root).then(res => {
      if (res.ok) Logger.info('Installed the project\'s script tools (npm install)', 'Editor')
      else Logger.warn(`npm install in the project folder failed: ${res.error}`, 'Editor')
    })
  }
}

/**
 * Write a bundle (an example, an imported .zip) as a new folder project in `root`, and open it. The files
 * written stay in memory for the open, so it ingests them without reading them back from disk.
 */
export async function installBundleToFolder(bundle: BundleData, rootIn: string, name: string, options: FolderProjectOptions & { load?: LoadHandle | null } = {}): Promise<boolean> {
  const root = await prepare(rootIn)
  const load = options.load ?? continueLoad()
  const uid = cryptoRandomId()
  const { snapshot, notes } = await bundleToFolder(bundle, { uid, name })
  for (const n of notes) Logger.warn(`${n.rel ? `${n.rel}: ` : ''}${n.message}`, 'Editor')
  load?.addSteps([{ id: 'folder-write', label: 'Writing the project folder', weight: 3 }])
  const step = load?.step('folder-write')
  step?.start('Writing the project folder')
  await writeSnapshot(root, snapshot, (done, total) => step?.progress(done, total))
  step?.done()
  await finishNewFolder(root, name, options)
  return openFolderProject(root, { confirm: null, title: `Opening ${name}`, preloaded: { files: snapshot.files, blobs: snapshot.blobs } })
}

/** Whether `root` is the folder of a record this machine knows (the launcher's "already installed" check). */
export async function knownFolder(root: string): Promise<boolean> {
  return !!(await recordOfFolder(root))
}

/**
 * Make the renderer's records match the main process's list of project folders (which survives clearing the
 * site data, and is shared by every origin of this build): a folder the list has and the records do not gets
 * a record, so it shows in the launcher with its cache rebuilt on open.
 */
export async function adoptRegisteredFolders(): Promise<void> {
  const bridge = getProjectBridge()
  if (!bridge) return
  const res = await bridge.registry()
  if (!res.ok) return
  for (const entry of res.projects) {
    if (entry.missing || !entry.project) continue
    if (await recordOfFolder(entry.root)) continue
    const parsed = parseProjectFile(entry.project)
    if (parsed.ok) await ensureFolderRecord(entry.root, parsed.file.name, parsed.file.uid)
  }
}

/**
 * A launch that asked for a project (`--cleo-open`, a double-clicked project.cleo): its record, made if this
 * machine has not opened that folder before. Taken once, at boot.
 */
export async function takeLaunchProject(): Promise<{ id: string; play: boolean; debug: boolean } | null> {
  const bridge = getProjectBridge()
  if (!bridge) return null
  const request = await bridge.takeLaunchRequest()
  if (!request) return null
  const file = await readProjectFile(request.root)
  if (!file.ok) { Logger.error(`Could not open ${request.root}: ${file.error}`, 'Editor'); return null }
  const record = await ensureFolderRecord(request.root, file.name, file.uid)
  await bridge.remember(request.root, file.name)
  return { id: record.id, play: request.play, debug: request.debug }
}

// The project switch reads a folder project's folder through here.
registerFolderSync(async (pid, root, load) => { await syncCacheFromFolder(pid, root, load, takePreloaded(pid)) })

export type { CachedFile }
