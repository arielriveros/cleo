// A skeleton as a shared library asset.
//
// WHY THIS EXISTS. A character's skeleton used to be discovered rather than declared: `skinnedModelJsonOf`
// takes the FIRST sub-mesh in a model's `nodeJson` that happens to carry a `.skin`, and everything built on
// that — clip retargeting, the IK rig, bone names — silently no-ops when the guess misses. That is how a
// model could list its animations in the inspector while none of them ever played. It also meant hand-
// authored skeleton data (the foot-IK setup, imported bone names) lived inside one model's serialized
// subtree, where a re-save could lose it and no second character could share it.
//
// A rig makes the skeleton a first-class, named, shareable thing. A model points at one (`rigId`); so does
// an `.anim` asset, naming the skeleton its clips were authored against — which is exactly what
// `buildBoneMapping` needs, and which each animation previously carried as its own private copy.
//
// Must stay engine-free (no `cleo` import) so it is unit-testable without a GL context, like
// animationAssets.ts.

import { cryptoRandomId } from './ids'
import type { StoredSkin } from './animationAssets'

export type RigAsset = {
  id: string
  name: string
  /**
   * The skeleton, in the flattened shape `AnimatedModel.serialize` writes (see {@link StoredSkin}).
   *
   * NESTED under `skin`, not spread across this record, and that is load-bearing: `bundleAssets.ts` packs a
   * format-2 bundle by looking for `value.skin && !value.model`, so nesting makes every rig's inverse-bind
   * matrices and node transforms get chunked into `assets.bin` automatically. Spread fields would ship as
   * raw JSON number arrays in every bundle, with nothing anywhere to catch it.
   */
  skin: StoredSkin
  /**
   * Foot-IK setup. Belongs to the SKELETON — its fields are joint indices into this skin — which is also
   * why it could never really live on one model.
   */
  ikRig?: any
  /**
   * The shared `.anim` assets authored against this skeleton. Every model with this `rigId` plays them —
   * which is the point: linking a walk cycle once serves every character built on the armature, instead of
   * three separate links that then drift apart.
   */
  animationIds?: string[]
  /**
   * Manual bone re-points onto THIS skeleton, keyed by the SOURCE rig each one corrects.
   *
   * A retarget is a relationship between two skeletons, so a correction belongs to the pair rather than to
   * one clip — fix `mixamorig:Spine -> chest` once and every clip authored on that source rig retargets
   * correctly onto this one, forever. Before this, a re-point made in the import modal was thrown away
   * (see `importAnimationFiles`).
   *
   * BY BONE NAME, never node index. Node indices are stable only within one export, and
   * `skeletonFingerprint` deliberately ignores `nodeNames` so a name backfill upgrades a rig in place
   * rather than forking it — an index-keyed override would silently point at the wrong bone afterwards.
   *
   * Sparse OVERRIDES, never a stored `BoneMapping`: everything else in a mapping (`kind`, `sameRig`,
   * `canRetarget`, `matchMode`) is derived from the two skins and would go stale, and `mapping.entries`
   * only covers bones the clips animate — so a whole-mapping snapshot could not express a re-point for a
   * bone no clip drives.
   */
  retargets?: Record<string, RetargetOverride[]>
  /** The file this came from, so a re-import can offer the existing rig instead of a second copy. */
  sourceFile?: string
  thumbnail?: string
}

/** One hand-made bone re-point. `targetName: null` means "drop this bone's curve". */
export type RetargetOverride = {
  sourceName: string
  targetName: string | null
}

export function buildRigAsset(name: string, skin: StoredSkin, sourceFile?: string, id?: string): RigAsset {
  return { id: id ?? cryptoRandomId(), name, skin, sourceFile }
}

/** Quantise a bind-matrix element. Looser than `clipFingerprint`'s — see {@link skeletonFingerprint}. */
const q = (n: number) => (Math.abs(n) < 1e-6 ? 0 : Math.round(n * 1e4) / 1e4)

/**
 * A content fingerprint for a skeleton: everything that decides whether a clip retargets onto it, and
 * nothing else. Two imports of the same character must produce the same string.
 *
 * Four decisions, each of which has a way of going wrong:
 *
 *  - **`name` is excluded**, same reasoning as `clipFingerprint`: one download is routinely renamed per
 *    character.
 *  - **Joints are NOT sorted.** Their order is meaningful — an animation channel indexes into it — so two
 *    skeletons with the same joints in a different order are genuinely different. This is the opposite of
 *    `clipFingerprint`, which sorts channels because their order is not meaningful.
 *  - **`nodeNames` is EXCLUDED**, even though `buildBoneMapping` matches on names. Bone names are the one
 *    part of a skeleton that gets *improved in place*: `importSkeletonNames` backfills them onto a rig that
 *    already exists. If names were part of the identity, that backfill would fork a second rig for the same
 *    skeleton and orphan the first — silently unlinking every animation pointing at it. Identity is the
 *    skeleton's SHAPE; the best available name table is then merged in by `preferRicherSkin`.
 *  - **`nodeTransforms` is excluded** for a related reason: exporters vary the rest pose in the low bits,
 *    and including it would split rigs that are the same skeleton.
 *
 *
 * Both exclusions hand their data to {@link preferRicherSkin}, which is therefore not optional — it is the
 * only thing keeping the richer copy when two fingerprint-equal skins meet.
 *
 * Quantisation is looser than `clipFingerprint`'s 1e-5 because a bind matrix survives more round trips
 * (import → serialize → bundle → parse) than a keyframe does.
 */
export function skeletonFingerprint(skin: StoredSkin | null | undefined): string {
  const joints = skin?.joints ?? []
  // An empty skeleton is not a skeleton. Returning '' and refusing to match it keeps two models that both
  // happen to have no joints from being collapsed onto one meaningless rig.
  if (!joints.length) return ''

  const jointPart = joints
    .map(j => `${j.nodeIndex}>${j.parentIndex ?? -1}:${Array.from(j.inverseBindMatrix ?? []).map(q).join(',')}`)
    .join(';')
  return `${skin?.skeleton ?? -1}#${jointPart}`
}

/**
 * Of two skeletons that fingerprint the same, the one worth keeping.
 *
 * NOT optional. `nodeTransforms` is excluded from the fingerprint, so two rigs can match while only one of
 * them carries the rest pose — and `buildBoneMapping`'s `canRetarget` needs it on both sides. Deduplicating
 * a rich skin onto a bare one would quietly drop every clip on that rig to index matching, which looks like
 * a subtly wrong character with nothing logged.
 *
 * Ties resolve to `existing`, which is what makes the migration idempotent: re-running it cannot keep
 * swapping two equally-good skins and re-writing the library.
 */
export function preferRicherSkin(existing: StoredSkin, incoming: StoredSkin): StoredSkin {
  const names = (s: StoredSkin) => s.nodeNames?.length ?? 0
  const transforms = (s: StoredSkin) => s.nodeTransforms?.length ?? 0
  if (names(incoming) > names(existing)) return incoming
  if (names(incoming) < names(existing)) return existing
  return transforms(incoming) > transforms(existing) ? incoming : existing
}

/** An existing rig with this exact skeleton, or undefined. Never matches an empty skeleton. */
export function findEquivalentRig(rigs: RigAsset[], skin: StoredSkin | null | undefined): RigAsset | undefined {
  const want = skeletonFingerprint(skin)
  if (!want) return undefined
  return rigs.find(r => skeletonFingerprint(r.skin) === want)
}

/** The rig an asset names, or undefined. Accepts anything carrying a `rigId`. */
export function rigOf(asset: { rigId?: string } | null | undefined, rigs: RigAsset[]): RigAsset | undefined {
  return asset?.rigId ? rigs.find(r => r.id === asset.rigId) : undefined
}

/**
 * The skeleton to retarget an animation FROM.
 *
 * `rigId` first, then the pre-rig `sourceSkin` each asset used to carry its own copy of. `sourceSkin` is
 * never deleted by the migration — it is the fallback for an asset whose rig was removed, and the only
 * thing an older build reading a newer bundle can use.
 */
export function sourceSkinFor(
  asset: { rigId?: string; sourceSkin?: StoredSkin | null } | null | undefined,
  rigs: RigAsset[],
): StoredSkin | null {
  return rigOf(asset, rigs)?.skin ?? asset?.sourceSkin ?? null
}

// ---------------------------------------------------------------------------------------------------
// Retarget overrides
// ---------------------------------------------------------------------------------------------------

/** The corrections stored for retargeting `sourceRigId`'s clips onto `rig`. Never undefined. */
export function overridesFor(rig: RigAsset | null | undefined, sourceRigId: string | undefined): RetargetOverride[] {
  if (!rig || !sourceRigId) return []
  return rig.retargets?.[sourceRigId] ?? []
}

/**
 * A copy of `rig` with one source bone re-pointed. `targetName: null` records a deliberate "drop this
 * bone"; passing `undefined` REMOVES the override, restoring the automatic match.
 *
 * Immutable, because the rig library is React state and `updateRig` diffs by identity.
 */
export function withOverride(
  rig: RigAsset,
  sourceRigId: string,
  sourceName: string,
  targetName: string | null | undefined,
): RigAsset {
  const current = overridesFor(rig, sourceRigId)
  const without = current.filter(o => o.sourceName !== sourceName)
  const next = targetName === undefined ? without : [...without, { sourceName, targetName }]

  const retargets = { ...(rig.retargets ?? {}) }
  // Drop the key entirely rather than storing an empty array: an empty override set and no override set
  // mean the same thing, and keeping both shapes would make every equality check ambiguous.
  if (next.length) retargets[sourceRigId] = next
  else delete retargets[sourceRigId]

  return { ...rig, retargets: Object.keys(retargets).length ? retargets : undefined }
}

/** Every override on `rig` cleared for one source rig — the "back to automatic" button. */
export function withoutOverrides(rig: RigAsset, sourceRigId: string): RigAsset {
  if (!rig.retargets?.[sourceRigId]) return rig
  const retargets = { ...rig.retargets }
  delete retargets[sourceRigId]
  return { ...rig, retargets: Object.keys(retargets).length ? retargets : undefined }
}

/**
 * name -> node index, for resolving a name-keyed override back to a node.
 *
 * Takes the name table rather than a whole skin so it serves both shapes: a `StoredSkin`'s entry PAIRS and
 * a live `Skin`'s `Map`, which is what the retarget path actually holds.
 */
export function nodeByName(nodeNames: Iterable<[number, string]> | null | undefined): Map<string, number> {
  const out = new Map<string, number>()
  for (const [node, name] of nodeNames ?? []) if (name && !out.has(name)) out.set(name, node)
  return out
}
