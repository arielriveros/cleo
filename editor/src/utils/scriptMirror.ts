import { type VfsIndex, dirOf, stemOf } from './vfs'
import { BASE_CLASS, type ScriptAsset, type ScriptBaseType } from './scripts'

// Pure mapping between the editor's script library (VfsIndex + ScriptAsset[]) and a real folder on disk
// that an external IDE can open — the "script workspace". Deliberately DOM-free, engine-free and
// Electron-free so the whole sync contract is unit-testable from the root vitest suite.
//
// Two directions, two plans:
//   planPush(prev, desired)      editor -> disk   (what to write/rename/delete)
//   planPull(prev, change)       disk -> editor   (what the watcher's changeset means)
//
// `prev` in both is the MirrorState: the last state BOTH sides agreed on. It is what makes a rename
// recoverable — see planPull.

/** Script assets are always TypeScript; a mirrored file is always `.ts`. */
export const MIRROR_EXT = '.ts'

/**
 * How many files may vanish from disk in one changeset before sync refuses to apply it.
 *
 * A script asset is shared: deleting it drops `__scriptId` (and the native field values) from every node
 * that referenced it. A `git checkout` of a branch without the scripts folder, or a folder moved in
 * Explorer, arrives as exactly that — a pile of deletions — so past this many the sync pauses and asks
 * instead of gutting the library. Renames are paired off BEFORE this is counted.
 */
export const BULK_DELETE_LIMIT = 3

/** One file as it should exist on disk. `rel` is workspace-relative and uses '/' separators. */
export type DesiredFile = {
  scriptId: string
  rel: string
  source: string
  hash: string
}

/** The last state the editor and the disk agreed on: scriptId -> where it lives and what it contained. */
export type MirrorState = Map<string, { rel: string; hash: string }>

/** What to do to the disk. Apply in this order: deletes, then renames, then writes. */
export type PushPlan = {
  deletes: string[]
  renames: { from: string; to: string }[]
  writes: { rel: string; source: string }[]
  next: MirrorState
  /**
   * Whether any FILE work is needed. `next` can move without this being true -- a script created or
   * edited on disk is already where it belongs, so only the id -> path mapping changed. Callers must
   * still persist `next` (the manifest) in that case: it is the identity record, and losing it makes the
   * next session read those files as brand new, mint fresh asset ids and break every `__scriptId` link.
   */
  filesChanged: boolean
}

/** A coalesced changeset from the workspace watcher. `removed` carries rel paths only. */
export type ExternalChange = {
  added: { rel: string; source: string }[]
  changed: { rel: string; source: string }[]
  removed: string[]
  /** The workspace root itself is gone (unmounted drive, folder moved). Never applied — always pauses. */
  rootMissing?: boolean
}

/** What a changeset means for the library. `paused` means: apply nothing, ask the user. */
export type PullPlan = {
  renames: { scriptId: string; from: string; to: string; source: string; sourceChanged: boolean }[]
  updates: { scriptId: string; rel: string; source: string }[]
  creates: { rel: string; source: string; baseType: ScriptBaseType }[]
  deletes: { scriptId: string; rel: string }[]
  paused: boolean
  pauseReason?: string
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * FNV-1a (32-bit) of the source, plus its length.
 *
 * Only ever compared against another value from this same function, so the algorithm is an internal
 * detail — the watcher hashes independently for its own snapshot and never sends hashes across.
 * Length is appended because FNV-1a alone is a 32-bit space and a script library is long-lived.
 */
export function hashSource(source: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}:${source.length}`
}

/* -------------------------------------------------------------------------- */
/* Path mapping                                                                */
/* -------------------------------------------------------------------------- */

// Windows refuses these outright, and the VFS accepts them: an asset renamed to `Aux` or `a:b` in the
// explorer must still land somewhere on disk. Sanitising is one-way — the manifest, not the filename,
// is what maps a file back to its script id, so a mangled name never loses the link.
const ILLEGAL_CHARS = /[<>:"|?*\\/\x00-\x1f]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Make one path segment safe to write on every platform. Never returns ''. */
export function sanitizeSegment(name: string): string {
  let out = name.replace(ILLEGAL_CHARS, '_')
  // Windows silently strips trailing dots and spaces, which would desync the name we recorded from the
  // name on disk and make every rescan look like a rename.
  out = out.replace(/[. ]+$/, '')
  if (RESERVED.test(out)) out = `_${out}`
  return out || '_'
}

/** '/Player/Playable.script' -> 'Player/Playable'. Sanitised, no extension. */
function mirrorStemPath(vfsPath: string): string {
  const dir = dirOf(vfsPath)
  const segments = dir === '/' ? [] : dir.split('/').filter(Boolean).map(sanitizeSegment)
  segments.push(sanitizeSegment(stemOf(vfsPath)))
  return segments.join('/')
}

/**
 * The workspace-relative path for a VFS script entry, disambiguated against `taken` (which this mutates).
 * '/Player/Playable.script' -> 'Player/Playable.ts'.
 */
export function mirrorRelOf(vfsPath: string, taken: Set<string>): string {
  const base = mirrorStemPath(vfsPath)
  let rel = `${base}${MIRROR_EXT}`
  // Same ' (2)' convention the explorer's uniquePath uses, so a collision reads the same in both places.
  let n = 2
  while (taken.has(rel.toLowerCase())) rel = `${base} (${n++})${MIRROR_EXT}`
  taken.add(rel.toLowerCase())
  return rel
}

/** 'Player/Playable.ts' -> '/Player/Playable.script'. The inverse used when disk invents a new file. */
export function vfsPathOfRel(rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  const cut = clean.toLowerCase().endsWith(MIRROR_EXT) ? clean.slice(0, -MIRROR_EXT.length) : clean
  return `/${cut}.script`
}

/* -------------------------------------------------------------------------- */
/* Base type inference                                                         */
/* -------------------------------------------------------------------------- */

const CLASS_TO_BASE_TYPE: Record<string, ScriptBaseType> = Object.fromEntries(
  Object.entries(BASE_CLASS).map(([type, cls]) => [cls, type as ScriptBaseType]),
) as Record<string, ScriptBaseType>

/**
 * Which node type a source file's class extends, for a file that appeared on disk with no asset behind it.
 * Falls back to 'node', which attaches to anything (`baseTypeMatchesNode`), so an unrecognised base is
 * never a hard failure.
 */
export function inferBaseType(source: string): ScriptBaseType {
  const m = /\bclass\s+[A-Za-z_$][\w$]*\s+extends\s+([A-Za-z_$][\w$]*)/.exec(source)
  return (m && CLASS_TO_BASE_TYPE[m[1]]) || 'node'
}

/* -------------------------------------------------------------------------- */
/* Editor -> disk                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where every script in the library should live on disk, derived from the VFS folder layout.
 * Entries whose asset is gone are skipped (the reconciler prunes them separately); sorted by VFS path so
 * collision disambiguation is deterministic across runs.
 */
export function buildDesiredMirror(vfs: VfsIndex, scripts: ScriptAsset[]): DesiredFile[] {
  const byId = new Map(scripts.map(s => [s.id, s]))
  const entries = vfs.entries
    .filter(e => e.kind === 'script' && byId.has(e.assetId))
    .sort((a, b) => a.path.localeCompare(b.path))

  const taken = new Set<string>()
  const out: DesiredFile[] = []
  for (const e of entries) {
    const asset = byId.get(e.assetId)!
    const source = asset.source ?? ''
    out.push({ scriptId: asset.id, rel: mirrorRelOf(e.path, taken), source, hash: hashSource(source) })
  }
  return out
}

/**
 * What the disk needs so it matches `desired`, given the last agreed state.
 *
 * A rename whose target is still occupied by a file this batch does not delete first (a swap, or a
 * collision with an unrelated file) degrades to delete+write rather than an fs.rename that would clobber.
 */
export function planPush(prev: MirrorState, desired: DesiredFile[]): PushPlan {
  const plan: PushPlan = { deletes: [], renames: [], writes: [], next: new Map(), filesChanged: false }
  const desiredIds = new Set(desired.map(d => d.scriptId))

  for (const [scriptId, p] of prev) {
    if (!desiredIds.has(scriptId)) plan.deletes.push(p.rel)
  }

  // Rels that will exist once the deletes above have run — a rename may only target a free one.
  const occupied = new Set<string>()
  for (const [scriptId, p] of prev) {
    if (desiredIds.has(scriptId)) occupied.add(p.rel.toLowerCase())
  }

  for (const d of desired) {
    plan.next.set(d.scriptId, { rel: d.rel, hash: d.hash })
    const p = prev.get(d.scriptId)

    if (!p) {
      plan.writes.push({ rel: d.rel, source: d.source })
      continue
    }
    if (p.rel === d.rel) {
      if (p.hash !== d.hash) plan.writes.push({ rel: d.rel, source: d.source })
      continue
    }
    occupied.delete(p.rel.toLowerCase())
    if (occupied.has(d.rel.toLowerCase())) {
      plan.deletes.push(p.rel)
      plan.writes.push({ rel: d.rel, source: d.source })
    } else {
      plan.renames.push({ from: p.rel, to: d.rel })
      if (p.hash !== d.hash) plan.writes.push({ rel: d.rel, source: d.source })
    }
    occupied.add(d.rel.toLowerCase())
  }

  plan.filesChanged = !!(plan.deletes.length || plan.renames.length || plan.writes.length)
  return plan
}

/* -------------------------------------------------------------------------- */
/* Disk -> editor                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What a watcher changeset means for the library.
 *
 * The hard part is renames: an IDE renaming a file produces a removal and a creation, and treating that
 * pair as delete+create would mint a new asset id and break `__scriptId` on every node using the script.
 * Two rules recover it, strongest first:
 *   1. a removal whose last-known content hash equals a creation's content — a pure rename;
 *   2. exactly one unmatched removal and one unmatched creation — a rename that was also edited.
 * Whatever is still unmatched afterwards is a genuine delete or a genuine new script, and only THEN is
 * the bulk-delete guard counted, so renaming a whole folder never trips it.
 */
export function planPull(prev: MirrorState, change: ExternalChange): PullPlan {
  const plan: PullPlan = { renames: [], updates: [], creates: [], deletes: [], paused: false }

  if (change.rootMissing) {
    plan.paused = true
    plan.pauseReason = 'The script workspace folder is no longer there.'
    return plan
  }

  const byRel = new Map<string, string>() // rel -> scriptId
  for (const [scriptId, p] of prev) byRel.set(p.rel, scriptId)

  const added = [...change.added]
  const removed = change.removed.filter(rel => byRel.has(rel))

  // (1) pair by content hash
  const pendingRemoved: string[] = []
  for (const rel of removed) {
    const scriptId = byRel.get(rel)!
    const wanted = prev.get(scriptId)!.hash
    const i = added.findIndex(a => hashSource(a.source) === wanted)
    if (i < 0) { pendingRemoved.push(rel); continue }
    const [hit] = added.splice(i, 1)
    plan.renames.push({ scriptId, from: rel, to: hit.rel, source: hit.source, sourceChanged: false })
  }

  // (2) the unambiguous rename-with-edit
  if (pendingRemoved.length === 1 && added.length === 1) {
    const rel = pendingRemoved.pop()!
    const hit = added.pop()!
    plan.renames.push({
      scriptId: byRel.get(rel)!, from: rel, to: hit.rel, source: hit.source, sourceChanged: true,
    })
  }

  for (const c of change.changed) {
    const scriptId = byRel.get(c.rel)
    if (!scriptId) { added.push(c); continue } // changed a file we never knew about — treat as new
    if (prev.get(scriptId)!.hash === hashSource(c.source)) continue // our own write echoing back
    plan.updates.push({ scriptId, rel: c.rel, source: c.source })
  }

  for (const a of added) {
    plan.creates.push({ rel: a.rel, source: a.source, baseType: inferBaseType(a.source) })
  }

  for (const rel of pendingRemoved) {
    plan.deletes.push({ scriptId: byRel.get(rel)!, rel })
  }

  if (plan.deletes.length > BULK_DELETE_LIMIT) {
    plan.paused = true
    plan.pauseReason = `${plan.deletes.length} script files were removed from the workspace at once.`
  }

  return plan
}

/** Fold an applied PullPlan back into the agreed state, so the next changeset diffs against the truth. */
export function advanceState(prev: MirrorState, plan: PullPlan, createdIds: Map<string, string>): MirrorState {
  const next = new Map(prev)
  for (const r of plan.renames) next.set(r.scriptId, { rel: r.to, hash: hashSource(r.source) })
  for (const u of plan.updates) next.set(u.scriptId, { rel: u.rel, hash: hashSource(u.source) })
  for (const d of plan.deletes) next.delete(d.scriptId)
  for (const c of plan.creates) {
    const id = createdIds.get(c.rel)
    if (id) next.set(id, { rel: c.rel, hash: hashSource(c.source) })
  }
  return next
}
