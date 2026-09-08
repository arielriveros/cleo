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
  /** The file this came from, so a re-import can offer the existing rig instead of a second copy. */
  sourceFile?: string
  thumbnail?: string
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
