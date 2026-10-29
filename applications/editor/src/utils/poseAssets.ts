// POSE assets: named static poses of a skeleton — Unreal's Pose Asset. A hand grip, a pointing finger,
// an injured stance.
//
// Each pose is stored as per-bone DELTAS from rest (the same `StoredPoseBone` form rig poses use), so one
// pose can ride on top of any clip as a `poseOffset` edit, or be held outright by a controller state —
// in a masked layer, that is a hand closing around a weapon while the rest of the body keeps moving.
//
// Pose ids are `cryptoRandomId()` and unique project-wide, so a clip's `poseOffset { poseId }` resolves
// against the UNION of a rig's legacy `poses` and every pose asset on that rig ({@link posesForRig}).
// That is what let poses move out of the rig without rewriting a single clip reference.
//
// Must stay engine-free so it is unit-testable without a GL context.

import { cryptoRandomId } from './ids'
import type { StoredPoseBone } from './animationAssets'
import type { RigAsset, RigPose } from './rigAssets'

export type PoseAsset = {
  id: string
  name: string
  rigId?: string
  poses: RigPose[]
  thumbnail?: string
}

export function buildPoseAsset(name: string, rigId?: string, poses: RigPose[] = [], id?: string): PoseAsset {
  return { id: id ?? cryptoRandomId(), name, ...(rigId ? { rigId } : {}), poses: poses.map(p => ({ ...p, bones: p.bones.map(b => ({ ...b })) })) }
}

export function newPose(name: string, bones: StoredPoseBone[]): RigPose {
  return { id: cryptoRandomId(), name, bones }
}

/** Every pose a rig can resolve: its own legacy list, then every pose asset authored on it. */
export function posesForRig(rig: RigAsset | null | undefined, assets: PoseAsset[]): RigPose[] {
  if (!rig) return []
  const own = rig.poses ?? []
  const fromAssets = assets.filter(a => a.rigId === rig.id).flatMap(a => a.poses)
  return own.length ? [...own, ...fromAssets] : fromAssets
}

/** Find a pose by id anywhere in a list of pose assets. */
export function findPose(assets: PoseAsset[], poseId: string): { asset: PoseAsset; pose: RigPose } | null {
  for (const asset of assets) {
    const pose = asset.poses.find(p => p.id === poseId)
    if (pose) return { asset, pose }
  }
  return null
}

/**
 * Move a rig's legacy `poses` into a pose asset. Ids are kept, so every clip referencing one still
 * resolves. Returns null when the rig has none.
 */
export function poseAssetFromRig(rig: RigAsset): PoseAsset | null {
  if (!rig.poses?.length) return null
  return buildPoseAsset(`${rig.name} Poses`, rig.id, rig.poses)
}
