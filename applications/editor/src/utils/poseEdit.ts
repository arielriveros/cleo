// Editing a POSE in the editor's pose mode (features/rig/PoseLibrary.tsx, PoseGizmo.tsx): the pure part.
//
// A stored pose bone is a delta from rest in the PARENT frame (`local = delta x rest`); a variant's bone is a
// delta from its base's, in the same frame (`local = rel x base x rest`, poseAssets.ts). So turning a bone by
// `turn` (a rotation in its parent's frame) is one pre-multiplication either way: `delta' = turn x delta`. That
// is what lets the gizmo edit a variant without resolving it first: what the drag adds lands in the variant.
//
// Must stay engine-free so it is unit-testable without a GL context.

import { quat } from 'gl-matrix'
import type { StoredPoseBone } from './animationAssets'
import { cryptoRandomId } from './ids'
import { buildPoseAsset, resolvePoseBones, type PoseAsset } from './poseAssets'
import type { RigPose } from './rigAssets'

// Plain arrays, not gl-matrix's Float32Array: a stored pose is doubles.
const q64 = (): quat => [0, 0, 0, 1] as unknown as quat
const asQuat = (v: number[] | undefined): quat => (v ? [v[0], v[1], v[2], v[3]] : [0, 0, 0, 1]) as unknown as quat

/** A rotation as stored: normalised, w >= 0. */
function stored(q: quat): number[] {
  quat.normalize(q, q)
  if (q[3] < 0) quat.scale(q, q, -1)
  return [q[0], q[1], q[2], q[3]]
}

/**
 * A turn the gizmo made in WORLD space (`worldTurn`), as a turn in the bone's PARENT frame, whose world rotation is
 * `parentWorld`: `inv(P) x worldTurn x P`. Both rotations only (scale divided out).
 */
export function parentFrameTurn(worldTurn: ArrayLike<number>, parentWorld: ArrayLike<number>): number[] {
  const P = asQuat(Array.from(parentWorld))
  const out = quat.multiply(q64(), quat.invert(q64(), P), quat.multiply(q64(), asQuat(Array.from(worldTurn)), P))
  return stored(out)
}

/** A pose's bones with one bone turned by `turn` (its parent frame): `delta' = turn x delta`. Added when absent. */
export function turnPoseBone(bones: StoredPoseBone[], name: string, turn: ArrayLike<number>): StoredPoseBone[] {
  const t = asQuat(Array.from(turn))
  const has = bones.some(b => b.name === name)
  const next = bones.map(b => (b.name === name ? { ...b, rotation: stored(quat.multiply(q64(), t, asQuat(b.rotation))) } : b))
  return has ? next : [...next, { name, rotation: stored(quat.clone(t) as quat) }]
}

/** A pose's bones with one bone's rotation set outright (the numbers' edit); a bone back at identity is dropped. */
export function setPoseBoneRotation(bones: StoredPoseBone[], name: string, rotation: ArrayLike<number>): StoredPoseBone[] {
  const r = stored(asQuat(Array.from(rotation)))
  const identity = Math.hypot(r[0], r[1], r[2]) < 1e-7
  const has = bones.some(b => b.name === name)
  const next = bones.flatMap(b => {
    if (b.name !== name) return [b]
    if (identity && !b.translation) return []
    const { rotation: _r, ...rest } = b
    return [identity ? rest : { ...rest, rotation: r }]
  })
  return has || identity ? next : [...next, { name, rotation: r }]
}

/** One pose of an asset replaced through `fn`; the same asset when it has no such pose. */
export function withPose(asset: PoseAsset, poseId: string, fn: (pose: RigPose) => RigPose | null): PoseAsset {
  if (!asset.poses.some(p => p.id === poseId)) return asset
  return { ...asset, poses: asset.poses.flatMap(p => { if (p.id !== poseId) return [p]; const next = fn(p); return next ? [next] : [] }) }
}

/** A new, empty variant of `base` (in `base`'s asset): it holds the base until a bone of it is turned. */
export function newVariant(base: { asset: PoseAsset; pose: RigPose }, name: string): RigPose {
  return { id: cryptoRandomId(), name, bones: [], baseRef: { assetId: base.asset.id, poseId: base.pose.id } }
}

/** A variant made a pose of its own: its bones resolved (as it looks now), its link to its base dropped. */
export function independentPose(assets: PoseAsset[], pose: RigPose): RigPose {
  const { baseRef: _b, ...own } = pose
  return { ...own, bones: resolvePoseBones(assets, pose).bones.map(b => ({ ...b })) }
}

/**
 * Where a new pose or variant of a rig goes when the pose it comes from may not be written (a Creator pose: the
 * next sync would undo it): the rig's own project asset, `<rig> Poses`, made when it has none.
 */
export function projectPoseAsset(assets: PoseAsset[], rigId: string, rigName: string, readOnly: (id: string) => boolean): { asset: PoseAsset; isNew: boolean } {
  const mine = assets.find(a => a.rigId === rigId && !readOnly(a.id))
  return mine ? { asset: mine, isNew: false } : { asset: buildPoseAsset(`${rigName} Poses`, rigId), isNew: true }
}

/** A name not taken by a pose of the asset: `name`, else `name 2`, `name 3`... */
export function freePoseName(asset: PoseAsset, name: string): string {
  const taken = new Set(asset.poses.map(p => p.name))
  if (!taken.has(name)) return name
  for (let k = 2; ; k++) if (!taken.has(`${name} ${k}`)) return `${name} ${k}`
}
