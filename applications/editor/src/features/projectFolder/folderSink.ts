// The editor's edits, written into the project folder.
//
// Fed from two sides. React state gives every library, the explorer index and the project's scene list
// (ProjectFolderProvider passes them in on every change). The stores give what React state does not carry:
// a scene's data when it is saved, and the bytes of images, sounds and bakes when they are stored
// (utils/folderStoreEvents.ts).
//
// A push never trusts a baseline. Each record is encoded the way the folder stores it and its sha256
// compared with the sha the folder holds (the session's state): equal means nothing to write. Once compared
// or written, the record OBJECT is remembered, and the editor's mutators replace the object of any asset
// they touch — so unchanged assets cost nothing after the first push of a session, and that first push is
// also what repairs a cache the editor left newer than the folder (a crash between the two writes).
//
// Every overwrite and delete carries the sha the editor last agreed is on disk; the main process refuses the
// ones whose file someone else changed in the meantime (they are reported, and left for a reload).

import { Logger } from 'cleo'
import { scheduleProjectWrite, trackProjectWrite } from '../../utils/projectLifecycle'
import { loadSceneData, type SceneAssetData, type SceneMeta } from '../../utils/sceneStorage'
import { getStoredTexture } from '../../utils/textureStore'
import { getStoredAudio } from '../../utils/audioStore'
import { isLodTextureId } from '../../utils/lodTextureIds'
import { isRawByteKind, type AssetKind, type VfsIndex } from '../../utils/vfs'
import { setFolderStoreListener, type FolderStoreListener } from '../../utils/folderStoreEvents'
import { encodeFolderJob } from '../../workers/workerClient'
import type { EncodedFolderAsset } from '../../workers/projectJobs'
import type { AssetInput } from '../../utils/folder/codec'
import { sha256Hex } from '../../utils/folder/codec'
import { sceneHeaderOf, type CachedFile } from '../../utils/folder/folderDelta'
import { FOLDER_FORMAT, LIB_OF_KIND, projectFileText } from '../../utils/folder/projectCodec'
import { planPushMoves, keyOfAsset, type DesiredFile } from '../../utils/folder/plan'
import {
  ASSETS_DIR, INPUT_REL, PROJECT_FILE, SETTINGS_REL, bakeRel, derivedRel, metaRelOf, relOfVfsFolder, relOfVfsPath,
} from '../../utils/folder/layout'
import { toJsonText } from '../../utils/folder/jsonText'
import { getProjectBridge, MAX_BATCH_BYTES, type FolderApplyResult, type FolderBatch } from './desktopProject'
import { folderSession, journalKey, loadJournal, saveJournal, scheduleStateSave, type FolderSession } from './folderSession'

/** What the editor has, from React state. */
export interface SinkInputs {
  vfs: VfsIndex
  /** Every library, by its name (LIB_OF_KIND's values). */
  libs: Record<string, any[]>
  scenes: SceneMeta[]
  mainSceneId: string | null
  name: string
  settings: unknown | null
  inputMap: unknown | null
}

export interface SinkStatus {
  state: 'idle' | 'writing' | 'error' | 'paused'
  message?: string
  /** Files someone else changed while the editor was about to write them. */
  conflicts: string[]
  /** Deletions held for confirmation (more than one push may do unasked). */
  heldDeletes: number
  lastWriteAt?: number
}

interface Item {
  key: string
  kind: AssetKind
  guid: string
  rel: string
  created?: number
  record?: any
  sceneMeta?: SceneMeta
  owner?: { kind: AssetKind; guid: string }
}

const utf8 = new TextEncoder()

class FolderSink {
  private inputs: SinkInputs | null = null
  private armed = false
  private verified = new WeakSet<object>()
  private dirtyBytes = new Map<string, { blob: Blob; mime: string; config?: unknown }>()
  private dirtyAudio = new Map<string, { blob: Blob; mime: string }>()
  private savedScenes = new Map<string, SceneAssetData>()
  private bakePuts = new Map<string, Uint8Array>()
  private bakeDeletes = new Set<string>()
  private journal: Set<string> | null = null
  private conflicted = new Set<string>()
  private allowDeletes: number | undefined
  private cancelTimer: (() => void) | null = null
  private running: Promise<void> | null = null
  private again = false
  private status: SinkStatus = { state: 'idle', conflicts: [], heldDeletes: 0 }
  private listeners = new Set<() => void>()

  // ---- wiring -------------------------------------------------------------------------------------

  readonly storeListener: FolderStoreListener = {
    texturesPut: rows => { for (const r of rows) { this.dirtyBytes.set(r.id, { blob: r.blob, mime: r.mime, config: r.config }) } this.schedule() },
    texturesDeleted: () => this.schedule(),
    audioPut: rows => { for (const r of rows) this.dirtyAudio.set(r.id, { blob: r.blob, mime: r.mime }); this.schedule() },
    audioDeleted: () => this.schedule(),
    bakePut: (id, bytes) => { this.bakeDeletes.delete(id); this.bakePuts.set(id, bytes); this.schedule() },
    bakesDeleted: ids => { for (const id of ids) { this.bakePuts.delete(id); this.bakeDeletes.add(id) } this.schedule() },
    sceneSaved: (id, data) => { this.savedScenes.set(id, data as SceneAssetData); void this.journalAdd(journalKey('scene', id)); this.schedule() },
    sceneDeleted: () => this.schedule(),
  }

  attach(): void {
    setFolderStoreListener(this.storeListener)
  }

  detach(): void {
    setFolderStoreListener(null)
    this.armed = false
    this.inputs = null
    this.cancelTimer?.()
    this.cancelTimer = null
    this.verified = new WeakSet()
    this.dirtyBytes.clear(); this.dirtyAudio.clear(); this.savedScenes.clear(); this.bakePuts.clear(); this.bakeDeletes.clear()
    this.journal = null
    this.conflicted.clear()
    this.allowDeletes = undefined
    this.setStatus({ state: 'idle', conflicts: [], heldDeletes: 0 })
  }

  setInputs(inputs: SinkInputs): void {
    this.inputs = inputs
    this.schedule()
  }

  /** The editor has finished loading the project: from here on its state is complete and may be pushed. */
  arm(): void {
    if (this.armed) return
    this.armed = true
    this.schedule(0)
  }

  /** The user confirmed the held deletions: let the next push make up to that many. */
  confirmDeletes(): void {
    this.allowDeletes = Number.MAX_SAFE_INTEGER
    this.schedule(0)
  }

  /** Forget a conflict once the folder was read again (a reload). */
  clearConflicts(): void {
    this.conflicted.clear()
    this.setStatus({ ...this.status, conflicts: [] })
  }

  getStatus(): SinkStatus { return this.status }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private setStatus(next: SinkStatus): void { this.status = next; for (const fn of this.listeners) fn() }

  /** Every pending write now (a project switch, the menu's Save). Resolves when the folder has them. */
  async flushNow(): Promise<void> {
    this.cancelTimer?.()
    this.cancelTimer = null
    await this.run()
  }

  private schedule(ms = 600): void {
    if (!this.armed) return
    this.cancelTimer?.()
    // A project write: a switch runs it at once instead of losing it (utils/projectLifecycle.ts).
    this.cancelTimer = scheduleProjectWrite(ms, () => { this.cancelTimer = null; return this.run() })
  }

  private run(): Promise<void> {
    if (this.running) { this.again = true; return this.running }
    this.running = trackProjectWrite((async () => {
      try {
        do {
          this.again = false
          await this.flush()
        } while (this.again)
      } finally {
        this.running = null
      }
    })())
    return this.running
  }

  private async journalAdd(key: string): Promise<void> {
    const s = folderSession()
    if (!s) return
    this.journal ??= await loadJournal(s.pid)
    if (this.journal.has(key)) return
    this.journal.add(key)
    await saveJournal(s.pid, this.journal).catch(() => {})
  }

  private async journalRemove(keys: string[]): Promise<void> {
    const s = folderSession()
    if (!s || !keys.length) return
    this.journal ??= await loadJournal(s.pid)
    let changed = false
    for (const k of keys) if (this.journal.delete(k)) changed = true
    if (changed) await saveJournal(s.pid, this.journal).catch(() => {})
  }

  // ---- the push -----------------------------------------------------------------------------------

  private async flush(): Promise<void> {
    const s = folderSession()
    const bridge = getProjectBridge()
    const inputs = this.inputs
    if (!s || !bridge || !inputs || !this.armed) return
    this.journal ??= await loadJournal(s.pid)
    this.setStatus({ ...this.status, state: 'writing' })
    try {
      await this.push(s, inputs)
      this.setStatus({ ...this.status, state: this.status.heldDeletes ? 'paused' : 'idle', message: undefined, conflicts: [...this.conflicted], lastWriteAt: Date.now() })
    } catch (e) {
      const message = String((e as Error)?.message ?? e)
      Logger.error(`Could not write the project folder: ${message}`, 'Editor')
      this.setStatus({ ...this.status, state: 'error', message })
    }
  }

  private async push(s: FolderSession, inputs: SinkInputs): Promise<void> {
    const bridge = getProjectBridge()!
    const blocked = new Set(s.blocked.keys())

    // Where every asset belongs.
    const records = new Map<string, any>()
    for (const [kind, lib] of Object.entries(LIB_OF_KIND)) for (const r of inputs.libs[lib] ?? []) if (r?.id) records.set(keyOfAsset(kind, r.id), r)
    const items = new Map<string, Item>()
    const keep = new Set<string>()
    const scenesById = new Map(inputs.scenes.map(m => [m.id, m]))
    for (const e of inputs.vfs.entries) {
      const key = keyOfAsset(e.kind, e.assetId)
      const rel = relOfVfsPath(e.path, e.kind)
      if (e.kind === 'scene') {
        const meta = scenesById.get(e.assetId)
        if (meta) items.set(key, { key, kind: 'scene', guid: e.assetId, rel, created: e.created, sceneMeta: meta })
        else keep.add(key)
        continue
      }
      const record = records.get(key)
      if (!record) { keep.add(key); continue }
      items.set(key, { key, kind: e.kind, guid: e.assetId, rel, created: e.created ?? record.created, record })
    }
    // Records that ship without an explorer entry: a LOD level's downscaled twins, in Derived/.
    for (const image of inputs.libs.images ?? []) {
      const key = keyOfAsset('image', image.id)
      if (items.has(key) || !isLodTextureId(image.id)) continue
      items.set(key, { key, kind: 'image', guid: image.id, rel: derivedRel('image', image.id, ''), created: image.created, record: image })
    }
    for (const texture of inputs.libs.textures ?? []) {
      const key = keyOfAsset('texture', texture.id)
      if (items.has(key) || !isLodTextureId(texture.id)) continue
      items.set(key, { key, kind: 'texture', guid: texture.id, rel: derivedRel('texture', texture.id, ''), record: texture })
    }
    // A record whose explorer entry is still being made, or a scene not saved yet: neither placed nor deleted.
    for (const key of records.keys()) if (!items.has(key)) keep.add(key)
    for (const m of inputs.scenes) { const key = keyOfAsset('scene', m.id); if (!items.has(key)) keep.add(key) }

    const desired: DesiredFile[] = [...items.values()].map(i => ({ kind: i.kind, guid: i.guid, rel: i.rel }))
    const moves = planPushMoves(s.state, desired, keep, blocked, { allowDeletes: this.allowDeletes })
    if (moves.held.length) {
      if (this.status.heldDeletes !== moves.held.length) Logger.warn(`The project folder push would delete ${moves.held.length} files; waiting for confirmation`, 'Editor')
      this.setStatus({ ...this.status, heldDeletes: moves.held.length })
    } else if (this.status.heldDeletes) {
      this.setStatus({ ...this.status, heldDeletes: 0 })
    }
    if (moves.deletes.length) this.allowDeletes = undefined

    const agreedRelOf = new Map<string, string>()
    for (const [rel, f] of s.state) if (f.kind && f.guid) agreedRelOf.set(keyOfAsset(f.kind, f.guid), rel)

    // 1. Moves and removals first, in one batch.
    const first: FolderBatch = { deletes: [], renames: [] }
    for (const d of [...moves.deletes, ...moves.rewrites.map(r => ({ rel: r.from, expect: r.expect, kind: r.kind, guid: r.guid }))]) {
      if (this.conflicted.has(d.rel)) continue
      first.deletes!.push({ rel: d.rel, expect: d.expect })
      const meta = metaRelOf(d.rel)
      if (s.state.has(meta)) first.deletes!.push({ rel: meta, expect: s.state.get(meta)!.sha })
    }
    for (const r of moves.renames) {
      if (this.conflicted.has(r.from)) continue
      first.renames!.push({ from: r.from, to: r.to, expect: r.expect })
      const meta = metaRelOf(r.from)
      if (s.state.has(meta)) first.renames!.push({ from: meta, to: metaRelOf(r.to), expect: s.state.get(meta)!.sha })
    }
    // Folders: the explorer's folders exist on disk; one it no longer has is removed when empty.
    const wantDirs = new Set<string>([ASSETS_DIR, ...inputs.vfs.folders.map(relOfVfsFolder)])
    first.mkdirs = [...wantDirs].filter(d => !s.dirs.has(d))
    first.rmdirs = [...s.dirs].filter(d => d.startsWith(ASSETS_DIR + '/') && !wantDirs.has(d))
    for (const id of this.bakeDeletes) {
      const rel = bakeRel(id)
      if (s.state.has(rel)) first.deletes!.push({ rel, expect: s.state.get(rel)!.sha })
    }
    if (first.deletes!.length || first.renames!.length || first.mkdirs.length || first.rmdirs.length) {
      const res = await bridge.apply(s.root, first)
      this.absorb(s, res)
      for (const r of first.renames!) {
        if (res.stats[r.to]) { const prev = s.state.get(r.from); s.state.delete(r.from); if (prev) s.state.set(r.to, { ...prev, sha: res.stats[r.to]!.sha }) }
      }
      for (const d of first.deletes!) if (res.stats[d.rel] === null) s.state.delete(d.rel)
      for (const d of first.mkdirs) s.dirs.add(d)
      for (const d of first.rmdirs) if (!res.errors.some(e => e.rel === d)) s.dirs.delete(d)
      for (const id of this.bakeDeletes) if (res.stats[bakeRel(id)] === null || !s.state.has(bakeRel(id))) this.bakeDeletes.delete(id)
      for (const [k, rel] of agreedRelOf) {
        const moved = moves.renames.find(r => r.from === rel)
        if (moved && res.stats[moved.to]) agreedRelOf.set(k, moved.to)
        if (res.stats[rel] === null && !moved) agreedRelOf.delete(k)
      }
      scheduleStateSave()
    }

    // 2. Content: encode what may have changed, write what did.
    const todo: Item[] = []
    for (const item of items.values()) {
      if (blocked.has(item.rel) || this.conflicted.has(item.rel)) continue
      const onDisk = agreedRelOf.get(item.key) === item.rel
      if (item.kind === 'scene') {
        const header = sceneHeaderOf(item.sceneMeta!)
        const cached = onDisk ? s.state.get(item.rel) : undefined
        if (!onDisk || this.savedScenes.has(item.guid) || cached?.header !== header || this.journal!.has(journalKey('scene', item.guid))) todo.push(item)
        continue
      }
      if (isRawByteKind(item.kind)) {
        const dirty = item.kind === 'image' ? this.dirtyBytes.has(item.guid) : this.dirtyAudio.has(item.guid)
        if (!onDisk || dirty || !this.verified.has(item.record)) todo.push(item)
        continue
      }
      if (!onDisk || !this.verified.has(item.record)) todo.push(item)
    }

    let chunk: { item: Item; input: AssetInput; size: number }[] = []
    let chunkBytes = 0
    const flushChunk = async () => {
      if (!chunk.length) return
      const outputs = await encodeFolderJob(chunk.map(c => c.input))
      await this.writeEncoded(s, chunk.map(c => c.item), outputs, agreedRelOf)
      chunk = []; chunkBytes = 0
    }
    for (const item of todo) {
      const input = await this.inputFor(item)
      if (!input) continue
      const size = input.bytes?.bytes.byteLength ?? 0
      chunk.push({ item, input, size })
      chunkBytes += size
      if (chunk.length >= 24 || chunkBytes > MAX_BATCH_BYTES / 2) await flushChunk()
    }
    await flushChunk()

    // 3. The project's own files.
    const writes: NonNullable<FolderBatch['writes']> = []
    const wantText = async (rel: string, text: string | null) => {
      const have = s.state.get(rel)
      if (text === null) return
      const sha = await sha256Hex(utf8.encode(text))
      if (have?.sha === sha || blocked.has(rel)) return
      writes.push({ rel, data: text, expect: have?.sha ?? null })
    }
    await wantText(PROJECT_FILE, projectFileText({
      cleo: 1, format: FOLDER_FORMAT, uid: s.project.uid, name: inputs.name,
      ...(inputs.mainSceneId && s.state.get(relOfScene(inputs, inputs.mainSceneId) ?? '') ? { mainScene: inputs.mainSceneId } : s.project.mainScene ? { mainScene: s.project.mainScene } : {}),
      ...(s.project.prefs ? { prefs: s.project.prefs } : {}),
    }))
    await wantText(SETTINGS_REL, inputs.settings === null ? null : toJsonText(inputs.settings))
    await wantText(INPUT_REL, inputs.inputMap === null ? null : toJsonText(inputs.inputMap))
    for (const [id, bytes] of this.bakePuts) {
      const rel = bakeRel(id)
      writes.push({ rel, data: bytes, expect: s.state.get(rel)?.sha ?? null })
    }
    if (writes.length) {
      const res = await bridge.apply(s.root, { writes })
      this.absorb(s, res)
      for (const w of writes) {
        const stat = res.stats[w.rel]
        if (!stat) continue
        s.state.set(w.rel, { sha: stat.sha })
        if (w.rel === PROJECT_FILE) s.project = { ...s.project, name: inputs.name, mainScene: inputs.mainSceneId ?? s.project.mainScene }
      }
      for (const id of [...this.bakePuts.keys()]) if (res.stats[bakeRel(id)]) this.bakePuts.delete(id)
      scheduleStateSave()
    }
  }

  /** What the encoder needs for one asset, or null when there is nothing to write yet. */
  private async inputFor(item: Item): Promise<AssetInput | null> {
    if (item.kind === 'scene') {
      const data = this.savedScenes.get(item.guid) ?? await loadSceneData(item.guid)
      // A scene that was never saved has no file yet.
      if (!data) return null
      return { kind: 'scene', guid: item.guid, created: item.created, scene: { meta: item.sceneMeta!, data } }
    }
    if (item.kind === 'image') {
      const row = this.dirtyBytes.get(item.guid) ?? await getStoredTexture(item.guid)
      if (!row) return null
      return { kind: 'image', guid: item.guid, created: item.created, record: item.record, bytes: { mime: row.mime, config: row.config, bytes: new Uint8Array(await row.blob.arrayBuffer()) } }
    }
    if (item.kind === 'audioSource') {
      const row = this.dirtyAudio.get(item.guid) ?? await getStoredAudio(item.guid)
      if (!row) return null
      return { kind: 'audioSource', guid: item.guid, created: item.created, record: item.record, bytes: { mime: row.mime, bytes: new Uint8Array(await row.blob.arrayBuffer()) } }
    }
    return { kind: item.kind, guid: item.guid, created: item.created, record: item.record }
  }

  /** Write the encoded assets whose file or meta differs from what the folder holds. */
  private async writeEncoded(s: FolderSession, items: Item[], outputs: EncodedFolderAsset[], agreedRelOf: Map<string, string>): Promise<void> {
    const bridge = getProjectBridge()!
    const blobs: NonNullable<FolderBatch['blobs']> = []
    const writes: NonNullable<FolderBatch['writes']> = []
    const done: { item: Item; out: EncodedFolderAsset; wroteContent: boolean; wroteMeta: boolean }[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const out = outputs[i]
      if (!out || out.error) { Logger.warn(`Could not encode ${item.rel}: ${out?.error}`, 'Editor'); continue }
      const have = agreedRelOf.get(item.key) === item.rel ? s.state.get(item.rel) : undefined
      const haveMeta = have ? s.state.get(metaRelOf(item.rel)) : undefined
      const wroteContent = have?.sha !== out.contentSha
      const wroteMeta = haveMeta?.sha !== out.metaSha
      if (wroteContent) {
        for (const [hash, data] of out.blobs) if (!s.blobs.has(hash)) blobs.push({ hash, data })
        // Bytes before meta: a reader never sees a meta whose file is not there yet.
        writes.push({ rel: item.rel, data: out.content, expect: have?.sha ?? null })
      }
      if (wroteMeta) writes.push({ rel: metaRelOf(item.rel), data: out.meta, expect: haveMeta?.sha ?? (have ? undefined : null) })
      done.push({ item, out, wroteContent, wroteMeta })
    }

    if (blobs.length) {
      let batch: typeof blobs = []
      let bytes = 0
      for (const b of blobs) {
        if (batch.length && bytes + b.data.byteLength > MAX_BATCH_BYTES) { this.absorb(s, await bridge.apply(s.root, { blobs: batch })); batch = []; bytes = 0 }
        batch.push(b); bytes += b.data.byteLength
      }
      const res = await bridge.apply(s.root, { blobs: batch })
      this.absorb(s, res)
      if (!res.ok) throw new Error(res.errors[0]?.error || 'could not store blobs')
      for (const b of blobs) s.blobs.add(b.hash)
    }

    const res = writes.length ? await bridge.apply(s.root, { writes }) : null
    if (res) this.absorb(s, res)
    const sceneKeys: string[] = []
    for (const { item, out, wroteContent, wroteMeta } of done) {
      const contentOk = !wroteContent || !!res?.stats[item.rel]
      const metaOk = !wroteMeta || !!res?.stats[metaRelOf(item.rel)]
      if (contentOk) {
        const prev = s.state.get(item.rel)
        s.state.set(item.rel, {
          sha: wroteContent ? res!.stats[item.rel]!.sha : prev!.sha,
          kind: item.kind, guid: item.guid, created: item.created, refs: out.refs,
          ...(item.kind === 'scene' ? { header: sceneHeaderOf(item.sceneMeta!) } : {}),
        })
        agreedRelOf.set(item.key, item.rel)
      }
      if (metaOk && wroteMeta) s.state.set(metaRelOf(item.rel), { sha: res!.stats[metaRelOf(item.rel)]!.sha })
      if (contentOk && metaOk) {
        if (item.record) this.verified.add(item.record)
        if (item.kind === 'image') this.dirtyBytes.delete(item.guid)
        if (item.kind === 'audioSource') this.dirtyAudio.delete(item.guid)
        if (item.kind === 'scene') { this.savedScenes.delete(item.guid); sceneKeys.push(journalKey('scene', item.guid)) }
      }
    }
    await this.journalRemove(sceneKeys)
    scheduleStateSave()
  }

  /** Take in what a batch reports: conflicts are remembered (and left alone until the folder is read again). */
  private absorb(s: FolderSession, res: FolderApplyResult): void {
    for (const c of res.conflicts ?? []) {
      if (!this.conflicted.has(c.rel)) Logger.warn(`${c.rel} changed on disk; the editor's version was not written`, 'Editor')
      this.conflicted.add(c.rel)
    }
    if (res.errors?.length) Logger.warn(`The project folder refused ${res.errors.length} write(s): ${res.errors[0].rel}: ${res.errors[0].error}`, 'Editor')
    void s
  }
}

/** The rel the main scene's file has, to check the scene is on disk before project.cleo names it. */
function relOfScene(inputs: SinkInputs, id: string): string | null {
  const entry = inputs.vfs.entries.find(e => e.kind === 'scene' && e.assetId === id)
  return entry ? relOfVfsPath(entry.path, 'scene') : null
}

/** The one sink: there is one open project. */
export const folderSink = new FolderSink()

/** For the menu: whatever the sink holds, written now. */
export function flushFolderSink(): Promise<void> {
  return folderSink.flushNow()
}

export type { CachedFile }
