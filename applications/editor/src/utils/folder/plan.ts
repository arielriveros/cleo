// Where the editor's assets must be on disk, against where the folder has them: the moves and removals a
// push makes before any content is compared. Modelled on scriptMirror.planPush, for every kind.
//
// Identity is (kind, guid), never the path: an asset whose explorer path changed is RENAMED (with its meta),
// so git sees a rename and the content is not rewritten. A file is deleted only when its asset is gone
// from the editor altogether — no explorer entry and no record — never because a library has not loaded.
//
// Pure.

import type { AssetKind } from '../vfs'
import type { CachedFile } from './folderDelta'
import { collisionKey, metaRelOf } from './layout'

/** One asset the editor has, and the file it belongs in. */
export interface DesiredFile { kind: AssetKind; guid: string; rel: string }

export interface PushMoves {
  /** Asset files to move, each with its meta (the caller moves both). */
  renames: { from: string; to: string; expect: string; kind: AssetKind; guid: string }[]
  /** Asset files whose asset is gone, with what they must still hold to be deleted. */
  deletes: { rel: string; expect: string; kind: AssetKind; guid: string }[]
  /**
   * Assets whose file stays where it was but must be written afresh at the new place instead of moved —
   * the place is taken by another file that moves away in the same push. The old file is deleted.
   */
  rewrites: { from: string; to: string; expect: string; kind: AssetKind; guid: string }[]
  /** key -> where the asset's file is after the moves. */
  placed: Map<string, string>
  /** Deletes held back for confirmation (more than the guard allows in one push). */
  held: PushMoves['deletes']
}

export const keyOfAsset = (kind: string, guid: string) => `${kind}:${guid}`

/** More deletions than this in one push pause for the user: max(3, 5% of the folder's assets). */
export function deleteLimit(assetCount: number): number {
  return Math.max(3, Math.ceil(assetCount * 0.05))
}

/**
 * `agreed`: the cache state (what the folder holds). `desired`: every asset the editor has a place for.
 * `keep`: identities that exist in the editor without a place right now (a record whose explorer entry is
 * still being made) — never deleted. `blocked`: files the editor could not read — never touched.
 */
export function planPushMoves(
  agreed: Map<string, CachedFile>,
  desired: DesiredFile[],
  keep: Set<string>,
  blocked: Set<string>,
  opts: { allowDeletes?: number } = {},
): PushMoves {
  const agreedRelOf = new Map<string, string>()
  let assetCount = 0
  for (const [rel, f] of agreed) {
    if (!f.kind || !f.guid) continue
    agreedRelOf.set(keyOfAsset(f.kind, f.guid), rel)
    assetCount++
  }
  const occupied = new Map<string, string>()
  for (const [rel, f] of agreed) if (f.kind && f.guid) occupied.set(collisionKey(rel), keyOfAsset(f.kind, f.guid))

  const placed = new Map<string, string>()
  const renames: PushMoves['renames'] = []
  const rewrites: PushMoves['rewrites'] = []
  const wanted = new Set<string>()

  for (const d of desired) {
    const key = keyOfAsset(d.kind, d.guid)
    wanted.add(key)
    placed.set(key, d.rel)
    const from = agreedRelOf.get(key)
    if (!from || from === d.rel) continue
    if (blocked.has(from) || blocked.has(d.rel)) { placed.set(key, from); continue }
    const expect = agreed.get(from)!.sha
    const holder = occupied.get(collisionKey(d.rel))
    // The target is free, or it is this very file (a case-only rename on a case-insensitive disk).
    if (!holder || holder === key) renames.push({ from, to: d.rel, expect, kind: d.kind, guid: d.guid })
    else rewrites.push({ from, to: d.rel, expect, kind: d.kind, guid: d.guid })
  }

  const deletes: PushMoves['deletes'] = []
  for (const [key, rel] of agreedRelOf) {
    if (wanted.has(key) || keep.has(key) || blocked.has(rel)) continue
    const f = agreed.get(rel)!
    deletes.push({ rel, expect: f.sha, kind: f.kind!, guid: f.guid! })
  }

  const limit = opts.allowDeletes ?? deleteLimit(assetCount)
  const held = deletes.length > limit ? deletes.splice(0) : []
  return { renames, deletes, rewrites, placed, held }
}

/** The meta that travels with an asset file. */
export const metaOf = metaRelOf
