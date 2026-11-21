// Which asset each file of a folder project IS, decided on every read.
//
// A file's identity is (kind, guid), taken in this order:
//   1. its paired `.meta`;
//   2. for a JSON kind, the `id` inside the file (a meta lost in transit);
//   3. what the editor's cache index recorded for this path, when the content still matches;
//   4. an orphaned meta of the same kind whose old file had this content — a rename that left its meta
//      behind, which is exactly what an IDE's rename does with a hidden `.meta`;
//   5. a new id, minted the way that kind always mints one.
//
// Two files claiming one (kind, guid) means somebody copied a file together with its meta. The file the
// cache index knows under that guid keeps it, else the smallest path; every other one is re-minted, so a
// copy becomes a new asset instead of silently aliasing the original.
//
// A meta whose file is gone is reported, never deleted here: a rename can reach the editor split across
// two scans (the delete first), and deleting the meta in between would lose the identity.
//
// Pure.

import { isRawByteKind, type AssetKind } from '../vfs'
import { cryptoRandomId } from '../ids'
import { assetRelOfMeta, decodeSegment, isMetaRel, kindOfFileName, metaRelOf, nameOfRel } from './layout'
import { META_VERSION, parseMeta, type AssetMeta } from './meta'

/** One asset file as the reader found it. */
export interface FileFacts {
  rel: string
  /** Content digest, when known (the main process hashes every file it reports). */
  sha?: string
  /** For a JSON kind already parsed: its `id` field. */
  jsonId?: string
}

/** What the cache index remembers about a path from the last time the editor agreed with the disk. */
export interface KnownEntry { kind: AssetKind; guid: string; sha?: string }

export type IdentitySource = 'meta' | 'json-id' | 'index' | 'orphan' | 'minted' | 'reminted'

export interface ResolvedFile {
  rel: string
  kind: AssetKind
  guid: string
  meta: AssetMeta
  source: IdentitySource
  /** The meta on disk is missing or wrong and must be (re)written. */
  writeMeta: boolean
  /** For a JSON kind: the `id` inside the file no longer matches and must be rewritten in place. */
  rewriteId: boolean
  /** An orphaned meta this file adopted; it should be deleted once the new one is written. */
  adoptedMeta?: string
}

export interface BlockedFile { rel: string; reason: 'conflict' | 'lfs-pointer' | 'invalid'; message: string }

export interface IdentityResult {
  files: ResolvedFile[]
  /** Files the editor cannot read (a broken meta). Their cached versions stay; nothing overwrites them. */
  blocked: BlockedFile[]
  /** Files that are not assets (no meta, and no extension that says what they are). */
  ignored: string[]
  /** Metas whose file is gone and that nothing adopted. */
  orphanMetas: string[]
}

export interface ResolveOptions {
  /** rel -> what the cache index remembers. */
  known?: Map<string, KnownEntry>
  /**
   * Files unchanged on disk since the cache last agreed with it (a warm open): their identity is the one the
   * cache knows, without their meta being read again. They still count when looking for duplicates, and win.
   */
  fixed?: Map<string, KnownEntry>
  /** Ids already taken by assets outside this read, per kind (a partial read of a project). */
  takenIds?: Map<AssetKind, Set<string>>
}

const keyOf = (kind: AssetKind, guid: string) => `${kind}:${guid}`

/**
 * Mint an id the way the kind always has. Byte kinds and their records are named after the file they
 * arrived as (`rock.png`, `rock`), so a minted one is too, with a short random suffix only on a clash.
 */
export function mintId(kind: AssetKind, fileName: string, taken: Set<string>): string {
  const name = decodeSegment(fileName)
  if (kind === 'image' || kind === 'audioSource') {
    if (!taken.has(name)) return name
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let id: string
    do id = `${stem}-${cryptoRandomId().slice(0, 6)}${ext}`; while (taken.has(id))
    return id
  }
  if (kind === 'texture' || kind === 'soundSample') {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    if (!taken.has(stem)) return stem
    let id: string
    do id = `${stem}-${cryptoRandomId().slice(0, 6)}`; while (taken.has(id))
    return id
  }
  let id: string
  do id = cryptoRandomId(); while (taken.has(id))
  return id
}

/**
 * Resolve every asset file of a read. `metas` holds the text of every `.meta` found (by meta rel), `files`
 * every other file under Assets/ or Derived/.
 */
export function resolveIdentities(
  files: FileFacts[],
  metas: Map<string, string>,
  opts: ResolveOptions = {},
): IdentityResult {
  const known = opts.known ?? new Map<string, KnownEntry>()
  const blocked: BlockedFile[] = []
  const ignored: string[] = []

  const parsedMetas = new Map<string, AssetMeta>()
  const brokenMetas = new Set<string>()
  for (const [rel, text] of metas) {
    const parsed = parseMeta(text)
    if (parsed.ok) parsedMetas.set(rel, parsed.meta)
    else { brokenMetas.add(rel); blocked.push({ rel: assetRelOfMeta(rel), reason: parsed.reason, message: `its .meta: ${parsed.message}` }) }
  }

  const fileRels = new Set(files.map(f => f.rel))
  // Orphaned metas, indexed by what their old file was, for rule 4.
  const orphanByContent = new Map<string, string>()
  for (const [metaRel, meta] of parsedMetas) {
    const assetRel = assetRelOfMeta(metaRel)
    if (fileRels.has(assetRel)) continue
    const old = known.get(assetRel)
    if (old?.sha && old.kind === meta.kind && old.guid === meta.guid) orphanByContent.set(`${meta.kind}:${old.sha}`, metaRel)
  }
  const adopted = new Set<string>()

  const taken = new Map<AssetKind, Set<string>>()
  const takenOf = (kind: AssetKind) => {
    let set = taken.get(kind)
    if (!set) { set = new Set(opts.takenIds?.get(kind) ?? []); taken.set(kind, set) }
    return set
  }
  // Every guid any meta or JSON id claims is taken before anything is minted, so a mint never collides
  // with a file processed later.
  for (const meta of parsedMetas.values()) takenOf(meta.kind).add(meta.guid)

  const resolved: ResolvedFile[] = []
  const pendingMint: { facts: FileFacts; kind: AssetKind }[] = []

  const fixed = opts.fixed ?? new Map<string, KnownEntry>()
  for (const entry of fixed.values()) takenOf(entry.kind).add(entry.guid)

  for (const facts of files) {
    const metaRel = metaRelOf(facts.rel)
    const stays = fixed.get(facts.rel)
    if (stays) {
      resolved.push({ rel: facts.rel, kind: stays.kind, guid: stays.guid, meta: { cleo: META_VERSION, guid: stays.guid, kind: stays.kind }, source: 'index', writeMeta: false, rewriteId: false })
      continue
    }
    if (brokenMetas.has(metaRel)) continue
    const meta = parsedMetas.get(metaRel)
    if (meta) {
      resolved.push({ rel: facts.rel, kind: meta.kind, guid: meta.guid, meta, source: 'meta', writeMeta: false, rewriteId: !!facts.jsonId && facts.jsonId !== meta.guid && !isRawByteKind(meta.kind) })
      continue
    }
    const kind = kindOfFileName(nameOfRel(facts.rel))
    if (!kind) { ignored.push(facts.rel); continue }

    if (facts.jsonId) {
      takenOf(kind).add(facts.jsonId)
      resolved.push({ rel: facts.rel, kind, guid: facts.jsonId, meta: { cleo: META_VERSION, guid: facts.jsonId, kind }, source: 'json-id', writeMeta: true, rewriteId: false })
      continue
    }
    const old = known.get(facts.rel)
    if (old && old.kind === kind && facts.sha && old.sha === facts.sha) {
      takenOf(kind).add(old.guid)
      resolved.push({ rel: facts.rel, kind, guid: old.guid, meta: { cleo: META_VERSION, guid: old.guid, kind }, source: 'index', writeMeta: true, rewriteId: false })
      continue
    }
    const orphan = facts.sha ? orphanByContent.get(`${kind}:${facts.sha}`) : undefined
    if (orphan && !adopted.has(orphan)) {
      adopted.add(orphan)
      const meta = parsedMetas.get(orphan)!
      resolved.push({ rel: facts.rel, kind, guid: meta.guid, meta, source: 'orphan', writeMeta: true, rewriteId: false, adoptedMeta: orphan })
      continue
    }
    pendingMint.push({ facts, kind })
  }

  // Duplicates: the path the index knows under the guid keeps it, else the smallest path.
  const byKey = new Map<string, ResolvedFile[]>()
  for (const r of resolved) {
    const key = keyOf(r.kind, r.guid)
    const list = byKey.get(key)
    if (list) list.push(r); else byKey.set(key, [r])
  }
  const remint: ResolvedFile[] = []
  for (const list of byKey.values()) {
    if (list.length < 2) continue
    const keeper = list.find(r => fixed.has(r.rel))
      ?? list.find(r => { const k = known.get(r.rel); return k && k.kind === r.kind && k.guid === r.guid })
      ?? [...list].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))[0]
    for (const r of list) if (r !== keeper) remint.push(r)
  }
  for (const r of remint) {
    const guid = mintId(r.kind, nameOfRel(r.rel), takenOf(r.kind))
    takenOf(r.kind).add(guid)
    r.guid = guid
    r.meta = { ...r.meta, guid }
    r.source = 'reminted'
    r.writeMeta = true
    r.rewriteId = !isRawByteKind(r.kind)
    r.adoptedMeta = undefined
  }

  for (const { facts, kind } of pendingMint) {
    const guid = mintId(kind, nameOfRel(facts.rel), takenOf(kind))
    takenOf(kind).add(guid)
    resolved.push({ rel: facts.rel, kind, guid, meta: { cleo: META_VERSION, guid, kind }, source: 'minted', writeMeta: true, rewriteId: false })
  }

  const orphanMetas: string[] = []
  for (const metaRel of parsedMetas.keys())
    if (!fileRels.has(assetRelOfMeta(metaRel)) && !adopted.has(metaRel)) orphanMetas.push(metaRel)

  // Stable order: the reader's, which is path order.
  const order = new Map(files.map((f, i) => [f.rel, i]))
  resolved.sort((a, b) => order.get(a.rel)! - order.get(b.rel)!)
  return { files: resolved, blocked, ignored, orphanMetas }
}

/** Split a listing into asset files and metas, the two inputs `resolveIdentities` takes. */
export function splitListing(rels: string[]): { assets: string[]; metas: string[] } {
  const assets: string[] = []
  const metas: string[] = []
  for (const rel of rels) (isMetaRel(rel) ? metas : assets).push(rel)
  return { assets, metas }
}
