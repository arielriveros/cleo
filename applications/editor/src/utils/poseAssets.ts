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
// ## Variants
//
// A pose may be a VARIANT of another (`RigPose.baseRef`): its bones are then stored RELATIVE to that base,
// in the same parent-frame form (`R = rel x base`, `T = base + rel`, {@link composePoseBones}). Editing the
// base moves every variant with it; editing a variant changes only that one. An aim offset is one aim pose
// and its directions as variants: a blend space of them on an additive layer adds what each direction
// changes from the aim (the embedded pose's `reference` is the resolved base), so editing the aim pose
// updates every direction. Everything that plays or ships a pose reads it RESOLVED ({@link resolvedPoseFor});
// only the pose editor sees the relative bones. A base may live in another asset (a variant of a read-only
// Creator pose lives in a project asset), so the link names both ids.
//
// Must stay engine-free so it is unit-testable without a GL context.

import { quat, vec3 } from 'gl-matrix'
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

/**
 * Every pose a rig can resolve: its own legacy list, then every pose asset authored on it. Variants come
 * RESOLVED (their bones composed onto their base's): this is what clips' `poseOffset` and publish read.
 */
export function posesForRig(rig: RigAsset | null | undefined, assets: PoseAsset[]): RigPose[] {
  if (!rig) return []
  const own = rig.poses ?? []
  const fromAssets = assets.filter(a => a.rigId === rig.id).flatMap(a => a.poses)
    .map(p => (p.baseRef ? { ...p, bones: resolvePoseBones(assets, p).bones } : p))
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

// --- Variants ---------------------------------------------------------------------------------------

/** A link to one pose: the asset holding it and its id. The shape of a state's `poseRef`. */
export type PoseRef = { assetId: string; poseId: string }

/** The key a pose sample goes by in a blend space (its `clipName`); the engine's `poseSampleKey`. */
export const poseSampleKey = (poseId: string): string => `pose:${poseId}`

const IDENTITY_EPSILON = 1e-6

// Plain arrays, not gl-matrix's Float32Array: a stored pose is doubles, and float32 scratch would write its
// rounding noise into every resolved pose (-0.1 coming back as -0.10000000149011612).
const q64 = (): quat => [0, 0, 0, 1] as unknown as quat
const v64 = (): vec3 => [0, 0, 0] as unknown as vec3
const rotationOf = (b: StoredPoseBone | undefined): quat =>
  (b?.rotation ? [b.rotation[0], b.rotation[1], b.rotation[2], b.rotation[3]] : [0, 0, 0, 1]) as unknown as quat
const translationOf = (b: StoredPoseBone | undefined): vec3 =>
  (b?.translation ? [b.translation[0], b.translation[1], b.translation[2]] : [0, 0, 0]) as unknown as vec3

/** A rotation as stored: normalised, w >= 0 (q and -q are one turn), so equal turns write equal JSON. */
function storedRotation(q: quat): number[] {
  quat.normalize(q, q)
  if (q[3] < 0) quat.scale(q, q, -1)
  return [q[0], q[1], q[2], q[3]]
}

const isIdentity = (q: quat) => Math.hypot(q[0], q[1], q[2]) < IDENTITY_EPSILON
const isZero = (v: vec3) => Math.hypot(v[0], v[1], v[2]) < IDENTITY_EPSILON

/**
 * A variant's bones on its base's: per bone `R = rel.R x base.R` (the relative turn applied in the bone's
 * parent frame, after the base's) and `T = base.T + rel.T`. A bone missing on either side counts as at rest.
 * The result lists every bone of either, base order first.
 */
export function composePoseBones(base: StoredPoseBone[], rel: StoredPoseBone[]): StoredPoseBone[] {
  const baseBy = new Map(base.map(b => [b.name, b]))
  const relBy = new Map(rel.map(b => [b.name, b]))
  const names = [...base.map(b => b.name), ...rel.map(b => b.name).filter(n => !baseBy.has(n))]
  return names.map(name => {
    const b = baseBy.get(name), r = relBy.get(name)
    const out: StoredPoseBone = { name }
    if (b?.rotation || r?.rotation) out.rotation = storedRotation(quat.multiply(q64(), rotationOf(r), rotationOf(b)))
    if (b?.translation || r?.translation) out.translation = Array.from(vec3.add(v64(), translationOf(b), translationOf(r)))
    return out
  })
}

/**
 * The inverse of {@link composePoseBones}: what a pose changes from `base`, per bone (`rel.R = R x inv(base.R)`,
 * `rel.T = T - base.T`). A bone the pose leaves where its base has it is dropped, so a fresh variant is empty.
 */
export function relativePoseBones(resolved: StoredPoseBone[], base: StoredPoseBone[]): StoredPoseBone[] {
  const baseBy = new Map(base.map(b => [b.name, b]))
  const out: StoredPoseBone[] = []
  for (const p of resolved) {
    const b = baseBy.get(p.name)
    const r = quat.multiply(q64(), rotationOf(p), quat.invert(q64(), rotationOf(b)))
    const t = vec3.sub(v64(), translationOf(p), translationOf(b))
    const bone: StoredPoseBone = { name: p.name }
    if (!isIdentity(r)) bone.rotation = storedRotation(r)
    if (!isZero(t)) bone.translation = Array.from(t)
    if (bone.rotation || bone.translation) out.push(bone)
  }
  return out
}

/** The pose a link names: in its asset first, else anywhere (pose ids are unique project-wide). */
export function lookupPose(assets: PoseAsset[], ref: PoseRef): RigPose | null {
  return assets.find(a => a.id === ref.assetId)?.poses.find(p => p.id === ref.poseId) ?? findPose(assets, ref.poseId)?.pose ?? null
}

/**
 * A pose's bones RESOLVED: composed onto its base's, all the way down. `broken` when a base in the chain is
 * missing or the chain loops (that base then counts as rest), so the editor can flag it.
 */
export function resolvePoseBones(assets: PoseAsset[], pose: RigPose, seen: Set<string> = new Set()): { bones: StoredPoseBone[]; broken: boolean } {
  if (!pose.baseRef) return { bones: pose.bones, broken: false }
  seen.add(pose.id)
  const base = lookupPose(assets, pose.baseRef)
  if (!base || seen.has(base.id)) return { bones: pose.bones, broken: true }
  const under = resolvePoseBones(assets, base, seen)
  return { bones: composePoseBones(under.bones, pose.bones), broken: under.broken }
}

const copyBones = (bones: StoredPoseBone[]): StoredPoseBone[] => bones.map(b => ({
  name: b.name, ...(b.rotation ? { rotation: [...b.rotation] } : {}), ...(b.translation ? { translation: [...b.translation] } : {}),
}))

/**
 * A linked pose as the runtime embeds it (`AnimationPose`): its resolved bones, and for a variant its resolved
 * base as `reference`, what an additive layer measures it from. Null when the link dangles. Deep copies.
 */
export function resolvedPoseFor(assets: PoseAsset[], ref: PoseRef): { name: string; bones: StoredPoseBone[]; reference?: StoredPoseBone[] } | null {
  const pose = lookupPose(assets, ref)
  if (!pose) return null
  const bones = copyBones(resolvePoseBones(assets, pose).bones)
  if (!pose.baseRef) return { name: pose.name, bones }
  const base = lookupPose(assets, pose.baseRef)
  return { name: pose.name, bones, ...(base && base.id !== pose.id ? { reference: copyBones(resolvePoseBones(assets, base, new Set([pose.id])).bones) } : {}) }
}

/** One pose in a {@link poseTree}: where it lives, and its variants under it. */
export type PoseTreeNode = { asset: PoseAsset; pose: RigPose; variants: PoseTreeNode[]; broken: boolean }

/**
 * A rig's poses as a tree: every pose whose base is not listed (or that has none) at the top, its variants
 * nested under it, in asset then pose order. A variant whose base is missing sits at the top, `broken`.
 */
export function poseTree(assets: PoseAsset[], rigId: string | undefined): PoseTreeNode[] {
  const onRig = assets.filter(a => !rigId || a.rigId === rigId)
  const nodes = new Map<string, PoseTreeNode>()
  for (const asset of onRig) for (const pose of asset.poses) nodes.set(pose.id, { asset, pose, variants: [], broken: false })
  const roots: PoseTreeNode[] = []
  for (const node of nodes.values()) {
    const base = node.pose.baseRef ? lookupPose(assets, node.pose.baseRef) : null
    const parent = base ? nodes.get(base.id) : undefined
    if (node.pose.baseRef && !base) node.broken = true
    if (parent && parent !== node) parent.variants.push(node)
    else roots.push(node)
  }
  // A loop has no root: break it at its first pose, rather than lose those poses from the list.
  const listed = new Set<string>()
  const mark = (n: PoseTreeNode) => { if (listed.has(n.pose.id)) return; listed.add(n.pose.id); n.variants.forEach(mark) }
  roots.forEach(mark)
  for (const node of nodes.values()) {
    if (listed.has(node.pose.id)) continue
    node.broken = true
    roots.push(node)
    mark(node)
  }
  return roots
}

/** Every variant of a pose, all the way down (not the pose itself). */
export function variantsOf(assets: PoseAsset[], poseId: string): { asset: PoseAsset; pose: RigPose }[] {
  const out: { asset: PoseAsset; pose: RigPose }[] = []
  const seen = new Set<string>([poseId])
  const walk = (id: string) => {
    for (const asset of assets) for (const pose of asset.poses) {
      if (pose.baseRef?.poseId !== id || seen.has(pose.id)) continue
      seen.add(pose.id)
      out.push({ asset, pose })
      walk(pose.id)
    }
  }
  walk(poseId)
  return out
}

/**
 * A rig's poses as a picker lists them: the {@link poseTree} flattened in order, each with its depth (0: not a
 * variant of a listed pose), so a variant reads indented under its base.
 */
export function poseChoices(assets: PoseAsset[], rigId: string | undefined): { asset: PoseAsset; pose: RigPose; depth: number; broken: boolean }[] {
  const out: { asset: PoseAsset; pose: RigPose; depth: number; broken: boolean }[] = []
  const walk = (n: PoseTreeNode, depth: number) => { out.push({ asset: n.asset, pose: n.pose, depth, broken: n.broken }); n.variants.forEach(v => walk(v, depth + 1)) }
  poseTree(assets, rigId).forEach(n => walk(n, 0))
  return out
}

/** A pose as a blend space's pose table holds it (the engine's `AnimationPose`, `base` naming another entry's key). */
export type TablePose = { name: string; bones: StoredPoseBone[]; base?: string }

/**
 * A blend space's pose table (`AnimationField.poses`): every pose its samples' `poseRef`s name, once, by sample key.
 * A VARIANT goes in as it is stored (what it changes from its base) with its base's key, and the base goes in too,
 * resolved: so an aim pose and its 25 directions are the aim's bones once and a few bones each, not 25 full poses.
 * A sample whose pose is gone has no entry. `previous`: without the library, the entries the copy being replaced
 * had (and their bases).
 */
export function fieldPoseTable(
  samples: readonly { poseRef?: PoseRef }[],
  poses: PoseAsset[] | undefined,
  previous?: Record<string, TablePose> | null,
): Record<string, TablePose> {
  const table: Record<string, TablePose> = {}
  for (const s of samples) {
    if (!s.poseRef) continue
    const key = poseSampleKey(s.poseRef.poseId)
    if (table[key]) continue
    if (!poses) {
      const had = previous?.[key]
      if (!had) continue
      table[key] = had
      if (had.base && previous?.[had.base]) table[had.base] ??= previous[had.base]
      continue
    }
    const pose = lookupPose(poses, s.poseRef)
    if (!pose) continue
    const base = pose.baseRef ? lookupPose(poses, pose.baseRef) : null
    if (base && base.id !== pose.id && !resolvePoseBones(poses, pose).broken) {
      const baseKey = poseSampleKey(base.id)
      if (!table[baseKey]?.bones || table[baseKey].base) table[baseKey] = { name: base.name, bones: copyBones(resolvePoseBones(poses, base).bones) }
      table[key] = { name: pose.name, bones: copyBones(pose.bones), base: baseKey }
    } else {
      table[key] = { name: pose.name, bones: copyBones(resolvePoseBones(poses, pose).bones) }
    }
  }
  return table
}
