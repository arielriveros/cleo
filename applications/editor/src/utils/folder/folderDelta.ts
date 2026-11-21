// What changed in a project folder since the editor's cache last agreed with it, as edits to that cache.
//
// Opening a folder project compares the main process's listing (every file with its content hash) with the
// cache state (the hash of every file when the cache last took it in). Only what differs is read and
// decoded; everything else keeps the identity and the record the cache already holds. A cold cache (a fresh
// clone, another machine, the dev build opening what the packaged one wrote) is the same code with nothing
// remembered: every file differs.
//
// Pure. The caller does the I/O: it reads the files `filesToRead` names, then hands them to `readFolderDelta`.

import type { SceneAssetData, SceneMeta } from '../sceneStorage'
import { baseOf, isRawByteKind, repairVfs, stemOf, type AssetKind, type VfsEntry, type VfsIndex } from '../vfs'
import { decodeAsset, readAssetJson, withoutMeasured } from './codec'
import {
  ASSETS_DIR, INPUT_REL, PROJECT_FILE, SETTINGS_REL, assetRelOfMeta, bakeIdOfRel, kindOfFileName, metaRelOf, nameOfRel,
  roleOfRel, vfsFolderOfRel, vfsPathOfRel,
} from './layout'
import { parseJsonText, toJsonText } from './jsonText'
import { resolveIdentities, type IdentityResult, type KnownEntry } from './identity'
import { metaText, recordWithFileSlot, type AssetMeta } from './meta'
import { applyName, mintRecord, parseProjectFile, type FolderProblem, type ProjectFile } from './projectCodec'

/** What the cache remembers of one file. Asset files also carry their identity, references and birth. */
export interface CachedFile {
  sha: string
  kind?: AssetKind
  guid?: string
  created?: number
  refs?: string[]
  /** A scene file's header (its dimension and refs) as last written or read, so a change to it is noticed. */
  header?: string
}

/** What a scene file's header is, as the cache remembers it. */
export const sceneHeaderOf = (meta: { dimension?: string; refs?: unknown }): string =>
  JSON.stringify({ dimension: meta.dimension ?? null, refs: meta.refs ?? null })

export interface ListedFile { rel: string; sha: string; mtimeMs?: number; size?: number }

/** One asset as decoded from its files, ready to be written into the cache. */
export interface DecodedEntry {
  rel: string
  kind: AssetKind
  guid: string
  created: number
  /** Its explorer path, or null for Derived/ (no explorer entry). */
  path: string | null
  record?: any
  bytes?: { mime: string; config?: unknown; bytes: Uint8Array }
  scene?: { meta: SceneMeta; data: SceneAssetData }
  refs: string[]
}

export interface FolderDelta {
  /** Assets whose files are new or changed. */
  upserts: DecodedEntry[]
  /** Assets whose files are gone. */
  removed: { rel: string; kind: AssetKind; guid: string }[]
  /** The whole explorer index, as the folder now has it. */
  vfs: VfsIndex
  /** project.cleo, when it changed (or on a cold read). */
  project?: ProjectFile
  /** undefined: unchanged; null: the file is gone (defaults); else the new value. */
  settings?: unknown | null
  inputMap?: unknown | null
  bakes: { put: { id: string; bytes: Uint8Array }[]; removed: string[] }
  /** Files the editor cannot read. The cache keeps what it had for them and nothing may overwrite them. */
  blocked: FolderProblem[]
  /** Files the editor should write back: missing or wrong metas, ids re-minted after a copy. */
  fixes: Map<string, string>
  /** The cache state to remember once the delta has been applied. */
  next: Map<string, CachedFile>
  identity: IdentityResult
  /** True when nothing at all differed: the cache is the folder. */
  unchanged: boolean
}

/**
 * Which files a delta needs read: every new or changed file, a meta's asset when only the meta moved (its
 * identity or record may have changed), and an asset whose meta disappeared (it must be identified again).
 */
export function filesToRead(listing: ListedFile[], previous: Map<string, CachedFile>): string[] {
  const now = new Map(listing.map(f => [f.rel, f]))
  const out = new Set<string>()
  const changed = (rel: string) => { const p = previous.get(rel); const n = now.get(rel); return !!n && (!p || p.sha !== n.sha) }
  for (const f of listing) {
    const role = roleOfRel(f.rel)
    if (role === 'other' || role === 'blob') continue
    if (!changed(f.rel)) continue
    out.add(f.rel)
    if (role === 'asset' || role === 'derived') { if (now.has(metaRelOf(f.rel))) out.add(metaRelOf(f.rel)) }
    if (role === 'meta') { const asset = assetRelOfMeta(f.rel); if (now.has(asset)) out.add(asset) }
  }
  // A meta whose file is gone, when something was added: it may be the identity of a file renamed without
  // it (an IDE rename leaves the hidden .meta behind), so it is read for the adoption rule.
  if (out.size) {
    for (const f of listing) if (roleOfRel(f.rel) === 'meta' && !now.has(assetRelOfMeta(f.rel))) out.add(f.rel)
  }
  // A meta that vanished while its file stayed: the file must be identified afresh.
  for (const rel of previous.keys()) {
    if (roleOfRel(rel) !== 'meta' || now.has(rel)) continue
    const asset = assetRelOfMeta(rel)
    if (now.has(asset)) out.add(asset)
  }
  return [...out].sort()
}

const asText = (content: string | Uint8Array): string =>
  typeof content === 'string' ? content : new TextDecoder().decode(content)

export interface DeltaInput {
  listing: ListedFile[]
  /** Folders that exist (rels), for empty explorer folders. */
  dirs: string[]
  previous: Map<string, CachedFile>
  /** The content of every file `filesToRead` named. */
  read: Map<string, string | Uint8Array>
  getBlob: (hash: string) => Uint8Array | undefined
}

export async function readFolderDelta(input: DeltaInput): Promise<FolderDelta> {
  const { listing, previous, read } = input
  const blocked: FolderProblem[] = []
  const fixes = new Map<string, string>()
  const next = new Map<string, CachedFile>()
  const upserts: DecodedEntry[] = []
  const now = new Map(listing.map(f => [f.rel, f]))
  let unchanged = true
  for (const f of listing) { const p = previous.get(f.rel); if (roleOfRel(f.rel) !== 'other' && roleOfRel(f.rel) !== 'blob' && (!p || p.sha !== f.sha)) unchanged = false }
  for (const rel of previous.keys()) if (!now.has(rel)) unchanged = false

  // project.cleo, settings, input map: whole-file values.
  let project: ProjectFile | undefined
  if (read.has(PROJECT_FILE)) {
    const parsed = parseProjectFile(asText(read.get(PROJECT_FILE)!))
    if (parsed.ok) project = parsed.file
    else blocked.push({ rel: PROJECT_FILE, reason: 'invalid', message: parsed.message })
  }
  const optional = (rel: string): unknown | null | undefined => {
    if (read.has(rel)) {
      const parsed = parseJsonText(asText(read.get(rel)!))
      if (parsed.ok) return parsed.value
      blocked.push({ rel, reason: parsed.reason, message: parsed.message })
      return undefined
    }
    return previous.has(rel) && !now.has(rel) ? null : undefined
  }
  const settings = optional(SETTINGS_REL)
  const inputMap = optional(INPUT_REL)

  // Bakes.
  const bakes: FolderDelta['bakes'] = { put: [], removed: [] }
  for (const f of listing) {
    if (roleOfRel(f.rel) !== 'bake') continue
    const content = read.get(f.rel)
    if (content !== undefined) bakes.put.push({ id: bakeIdOfRel(f.rel)!, bytes: typeof content === 'string' ? new TextEncoder().encode(content) : content })
  }
  for (const rel of previous.keys()) if (roleOfRel(rel) === 'bake' && !now.has(rel)) bakes.removed.push(bakeIdOfRel(rel)!)

  // Identity of every asset file present now.
  const assetRels = listing.filter(f => { const r = roleOfRel(f.rel); return r === 'asset' || r === 'derived' }).map(f => f.rel).sort()
  const known = new Map<string, KnownEntry>()
  const fixed = new Map<string, KnownEntry>()
  for (const [rel, c] of previous) if (c.kind && c.guid) known.set(rel, { kind: c.kind, guid: c.guid, sha: c.sha })
  const metas = new Map<string, string>()
  const parsedJson = new Map<string, any>()
  const facts = []
  for (const rel of assetRels) {
    const prev = previous.get(rel)
    if (!read.has(rel) && prev?.kind && prev.guid) { fixed.set(rel, { kind: prev.kind, guid: prev.guid, sha: prev.sha }); facts.push({ rel }); continue }
    const metaRel = metaRelOf(rel)
    if (read.has(metaRel)) metas.set(metaRel, asText(read.get(metaRel)!))
    else if (now.has(metaRel) && prev?.kind && prev.guid) {
      // The meta did not change and was not read: it still says what the cache knows.
      metas.set(metaRel, metaText({ cleo: 1, guid: prev.guid, kind: prev.kind, ...(prev.created !== undefined ? { created: prev.created } : {}) }))
    }
    const fact: { rel: string; sha?: string; jsonId?: string } = { rel, sha: now.get(rel)?.sha }
    const content = read.get(rel)
    const metaKind = (() => { const t = metas.get(metaRel); if (!t) return undefined; try { return JSON.parse(t).kind } catch { return undefined } })()
    const kind = metaKind ?? kindOfFileName(nameOfRel(rel))
    if (content !== undefined && kind && !isRawByteKind(kind) && kind !== 'script') {
      const json = readAssetJson(asText(content))
      if (!json.ok) { blocked.push({ rel, reason: json.reason, message: json.message }); keepPrevious(rel); continue }
      parsedJson.set(rel, json.value)
      if (json.value && typeof json.value.id === 'string') fact.jsonId = json.value.id
    }
    facts.push(fact)
  }
  // Orphaned metas (their file is gone) still count for identity: a rename may have left one behind.
  for (const f of listing) {
    if (roleOfRel(f.rel) !== 'meta' || now.has(assetRelOfMeta(f.rel)) || metas.has(f.rel)) continue
    const content = read.get(f.rel)
    if (content !== undefined) metas.set(f.rel, asText(content))
  }

  function keepPrevious(rel: string) {
    // A blocked file: the cache keeps the identity and the record it had, and the file's references stay live.
    const p = previous.get(rel)
    if (p) next.set(rel, p)
    const metaRel = metaRelOf(rel)
    const pm = previous.get(metaRel)
    if (pm) next.set(metaRel, pm)
  }

  const identity = resolveIdentities(facts, metas, { known, fixed })
  for (const b of identity.blocked) { blocked.push(b); keepPrevious(b.rel) }
  const blockedRels = new Set(blocked.map(b => b.rel))

  const vfsEntries: VfsEntry[] = []
  for (const file of identity.files) {
    if (blockedRels.has(file.rel)) continue
    const inAssets = file.rel.startsWith(ASSETS_DIR + '/')
    const path = inAssets ? vfsPathOfRel(file.rel, file.kind) : null
    const fileName = path ? baseOf(path) : ''
    const prev = previous.get(file.rel)

    if (fixed.has(file.rel)) {
      next.set(file.rel, prev!)
      const metaRel = metaRelOf(file.rel)
      if (now.has(metaRel)) next.set(metaRel, { sha: now.get(metaRel)!.sha })
      if (path) vfsEntries.push({ path, kind: file.kind, assetId: file.guid, created: prev?.created ?? 0 })
      continue
    }

    const content = read.get(file.rel)
    if (content === undefined) { keepPrevious(file.rel); continue }
    const decoded = await decodeAsset(file.meta, content, input.getBlob, { mtime: now.get(file.rel)?.mtimeMs, parsed: parsedJson.get(file.rel) })
    if (!decoded.ok) { blocked.push({ rel: file.rel, reason: decoded.reason, message: decoded.message }); keepPrevious(file.rel); continue }

    const created = file.meta.created ?? prev?.created ?? 0
    const entry: DecodedEntry = { rel: file.rel, kind: file.kind, guid: file.guid, created, path, refs: decoded.refs }
    if (file.kind === 'scene') {
      entry.scene = { meta: { id: file.guid, name: stemOf(fileName), ...decoded.scene!.meta }, data: decoded.scene!.data }
    } else {
      let record = decoded.record ?? mintRecord(file.kind, file.guid, fileName, decoded.bytes)
      if (path) applyName(file.kind, record, fileName)
      entry.record = record
      if (decoded.bytes) entry.bytes = decoded.bytes
    }
    upserts.push(entry)
    if (path) vfsEntries.push({ path, kind: file.kind, assetId: file.guid, created })

    next.set(file.rel, {
      sha: now.get(file.rel)!.sha, kind: file.kind, guid: file.guid, created, refs: decoded.refs,
      ...(entry.scene ? { header: sceneHeaderOf(entry.scene.meta) } : {}),
    })
    const metaRel = metaRelOf(file.rel)
    if (file.writeMeta || file.rewriteId) {
      const meta: AssetMeta = { ...file.meta, ...(file.meta.created === undefined && created ? { created } : {}) }
      if ((file.kind === 'image' || file.kind === 'audioSource') && entry.bytes) {
        meta.record = withoutMeasured(file.kind, entry.record)
        meta.importer = file.kind === 'image' ? { mime: entry.bytes.mime, config: entry.bytes.config } : { mime: entry.bytes.mime }
      }
      if (file.kind === 'script' && entry.record) meta.record = recordWithFileSlot(entry.record, 'source')
      fixes.set(metaRel, metaText(meta))
    } else if (now.has(metaRel)) {
      next.set(metaRel, { sha: now.get(metaRel)!.sha })
    }
    if (file.rewriteId && parsedJson.has(file.rel)) {
      const raw = parsedJson.get(file.rel)
      raw.id = file.guid
      fixes.set(file.rel, toJsonText(raw))
    }
  }

  // What is gone: every asset the cache knew whose file is no longer there (and was not just renamed onto
  // a new path under the same identity — that one is an upsert with a new path, not a removal).
  const present = new Set(identity.files.map(f => `${f.kind}:${f.guid}`))
  for (const b of blocked) { const p = previous.get(b.rel); if (p?.kind && p.guid) present.add(`${p.kind}:${p.guid}`) }
  const removed: FolderDelta['removed'] = []
  for (const [rel, c] of previous) {
    if (!c.kind || !c.guid || now.has(rel)) continue
    if (present.has(`${c.kind}:${c.guid}`)) continue
    removed.push({ rel, kind: c.kind, guid: c.guid })
  }

  // The rest of the cache state: whole-value files and bakes, as the listing has them.
  for (const f of listing) {
    const role = roleOfRel(f.rel)
    if ((role === 'project' || role === 'settings' || role === 'input' || role === 'bake') && !blockedRels.has(f.rel)) next.set(f.rel, { sha: f.sha })
  }
  if (blockedRels.has(PROJECT_FILE) && previous.has(PROJECT_FILE)) next.set(PROJECT_FILE, previous.get(PROJECT_FILE)!)

  const folders = new Set<string>()
  for (const dir of input.dirs) { const f = vfsFolderOfRel(dir); if (f && f !== '/') folders.add(f) }
  const vfs = repairVfs({ version: 1, folders: [...folders], entries: vfsEntries }).next

  return { upserts, removed, vfs, project, settings, inputMap, bakes, blocked, fixes, next, identity, unchanged }
}
