// Resolving shared animation assets onto a concrete rig.
//
// An `.anim` asset stores its clips in the SOURCE rig's space (see animationAssets.ts), so playing one on
// a character means retargeting against that character's skeleton — at USE, not at import, which is what
// lets one stored walk serve any number of characters.
//
// This module needs the engine (the retarget maths lives there); it is split from animationAssets.ts to
// leave the storage half unit-testable without a GL context.

import { mat4 } from 'gl-matrix'
import {
  AnimatedModel, buildBoneMapping, retargetAnimation, applyManualMapping, Logger,
  type Animation, type BoneMapping, type Node, type Skin,
} from 'cleo'
import { loadSkin, type AnimationAsset, type StoredClip } from './animationAssets'
import { nodeByName, overridesFor, type RetargetOverride, type RigAsset } from './rigAssets'
import { skinnedModelJsonOf } from './modelClips'

const toMat4 = (a: number[]) => {
  const m = mat4.create()
  for (let i = 0; i < 16 && i < a.length; i++) m[i] = a[i]
  return m
}

/**
 * The skeleton a MODEL ASSET describes, rebuilt from its serialized subtree.
 * Reads the asset, not a live node: at import time there may be no instance of that character in the
 * scene. The shape is what `AnimatedModel.serialize` writes, so this and `AnimatedModel.parse` agree.
 */
export function modelAssetSkin(asset: { nodeJson: any } | null | undefined): Skin | null {
  const model = asset ? skinnedModelJsonOf(asset.nodeJson) : null
  return model?.skin ? (loadSkin(model.skin, toMat4) as Skin) : null
}

/**
 * How to look up a rig by id.
 *
 * The whole `RigAsset`, not just its skin: retargeting onto a rig also needs the manual bone re-points
 * stored on it.
 *
 * A module-level registration rather than a `rigs: RigAsset[]` parameter threaded through
 * `resolveAnimationAsset` -> `resolveModelAnimations` -> `applyModelAnimations` -> `refreshModelClips` ->
 * `instantiateModelAsset` and their call sites — the same shape `registerFoliageSourceResolver` and
 * `registerTemplates` already use for a cross-cutting dependency this module cannot own.
 */
let rigResolver: ((rigId: string) => RigAsset | null) | null = null

export function registerRigResolver(fn: ((rigId: string) => RigAsset | null) | null): void {
  // Registered from a RENDER body (as `registerFoliageSourceResolver` is), so this runs on every render of
  // the provider. It must therefore be idempotent and cheap — in particular it must NOT clear the retarget
  // cache, which would leave the cache permanently empty and re-run `buildBoneMapping` for every clip on
  // every play. Rig CONTENT changes invalidate the cache at their source, in `updateRig`.
  if (rigResolver === fn) return
  rigResolver = fn
}

/**
 * The skeleton to retarget `asset` FROM: its rig, else the copy it embedded before rigs existed.
 *
 * Returning null is meaningful — it means "cannot retarget", and the caller plays the clips untouched.
 */
export function sourceSkinOf(asset: Pick<AnimationAsset, 'rigId' | 'sourceSkin'>): Skin | null {
  const stored = (asset.rigId ? rigResolver?.(asset.rigId)?.skin : null) ?? asset.sourceSkin ?? null
  return stored ? (loadSkin(stored, toMat4) as Skin) : null
}

/** The rig an id names, through the registered resolver. */
export function rigById(rigId: string | undefined): RigAsset | null {
  return rigId ? rigResolver?.(rigId) ?? null : null
}

/**
 * Replay a target rig's manual bone re-points on top of an automatically-built mapping.
 *
 * The overrides are stored by NAME (see `RigAsset.retargets`) and `applyManualMapping` works in node
 * indices, so each one is resolved against the two live skins first. An override naming a bone that no
 * longer exists on either side is SKIPPED and reported once — a stale correction must never silently
 * re-point a different bone, which is what an index-keyed override would have done.
 */
export function applyRetargetOverrides(
  mapping: BoneMapping,
  overrides: RetargetOverride[],
  sourceSkin: Skin,
  targetSkin: Skin,
  reportKey: string,
): BoneMapping {
  if (!overrides.length) return mapping

  const sourceNodes = nodeByName(sourceSkin.nodeNames)
  const targetNodes = nodeByName(targetSkin.nodeNames)
  let out = mapping
  const missing: string[] = []

  for (const o of overrides) {
    const sourceNode = sourceNodes.get(o.sourceName)
    if (sourceNode === undefined) { missing.push(o.sourceName); continue }
    if (o.targetName === null) { out = applyManualMapping(out, sourceNode, null); continue }
    const targetNode = targetNodes.get(o.targetName)
    if (targetNode === undefined) { missing.push(o.targetName); continue }
    out = applyManualMapping(out, sourceNode, targetNode)
  }

  if (missing.length && !warnedMissingOverride.has(reportKey)) {
    warnedMissingOverride.add(reportKey)
    Logger.warn(
      `Retarget override skipped: ${missing.length} bone${missing.length === 1 ? '' : 's'} named in a saved ` +
      `correction no longer exist${missing.length === 1 ? 's' : ''} (${missing.slice(0, 5).join(', ')}).`, 'Editor')
  }
  return out
}


/** A per-session cache: the retarget is deterministic, so the same pair never needs computing twice. */
const cache = new Map<string, Animation[]>()

/** Models already reported as having no skeleton — see resolveModelAnimations. Cleared with the cache. */
const warnedNoSkin = new Set<string>()

/** Override sets already reported as naming a missing bone. Cleared with the cache. */
const warnedMissingOverride = new Set<string>()

/** Drop everything cached for one animation asset — call when its clips change or it is deleted. */
export function invalidateAnimationCache(animationId?: string): void {
  if (!animationId) { cache.clear(); warnedNoSkin.clear(); warnedMissingOverride.clear(); return }
  for (const key of [...cache.keys()]) if (key.startsWith(`${animationId}:`)) cache.delete(key)
}

/**
 * The clips `asset` contributes to a model, retargeted onto `targetSkin`.
 * `cacheKey` must identify the target rig (the model asset id); pass `undefined` to bypass the cache, as
 * for a preview built from an unsaved edit.
 * An asset with no source skin cannot be retargeted, so its clips are returned untouched.
 */
export function resolveAnimationAsset(
  asset: AnimationAsset, targetSkin: Skin, cacheKey?: string, targetRigId?: string,
): Animation[] {
  const key = cacheKey ? `${asset.id}:${cacheKey}` : ''
  if (key) { const hit = cache.get(key); if (hit) return hit }

  const clips = asset.clips as unknown as Animation[]
  const sourceSkin = sourceSkinOf(asset)

  let out: Animation[]
  if (!sourceSkin) {
    out = clips.map(c => ({ ...c }))
  } else {
    // ONE mapping for the whole asset: every clip in it shares the source skeleton.
    let mapping = buildBoneMapping(clips, sourceSkin, targetSkin)
    // ...then the human's corrections on top. This is what the import modal's re-points used to be thrown
    // away for: the automatic match is rebuilt on every retarget, so a fix only survives if it is stored
    // and replayed. They live on the TARGET rig, keyed by the source rig — see RigAsset.retargets.
    const overrides = overridesFor(rigById(targetRigId), asset.rigId)
    if (overrides.length) {
      mapping = applyRetargetOverrides(mapping, overrides, sourceSkin, targetSkin, `${asset.id}:${targetRigId}`)
    }
    out = clips.map(c => retargetAnimation(c, sourceSkin, targetSkin, mapping))
  }
  // Stamp the origin: AnimatedModel.serialize drops a clip carrying one, so a resolved clip plays but is
  // never written into a scene, a template or the published game.
  out = out.map(c => ({ ...c, assetId: asset.id }))
  if (key) cache.set(key, out)
  return out
}

/**
 * The animation asset ids a model plays: its RIG's list, plus any still recorded on the model itself.
 *
 * The rig is the owner — every character built on one armature plays the same clips, which is what makes
 * linking a walk cycle once worth doing. The model's own list is the pre-migration shape and is unioned in
 * so a project that has not yet run the v4 pass keeps playing; `extractRigs` empties it.
 */
export function modelAnimationIds(modelAsset: { rigId?: string; animationIds?: string[] }): string[] {
  const fromRig = rigById(modelAsset.rigId)?.animationIds ?? []
  const own = modelAsset.animationIds ?? []
  if (!own.length) return fromRig
  if (!fromRig.length) return own
  // Rig first, so a clip present in both keeps the rig's ORDER — the order clips are added in is what
  // `addAnimation`'s de-dupe suffixes against.
  return [...fromRig, ...own.filter(id => !fromRig.includes(id))]
}

/**
 * Every clip a model's animation ids resolve to, in order, ready to hand to `addAnimation`.
 * An id naming a deleted asset is skipped silently; the library is the source of truth.
 */
export function resolveModelAnimations(
  modelAsset: { id: string; nodeJson: any; rigId?: string; animationIds?: string[] },
  animations: AnimationAsset[],
): StoredClip[] {
  const ids = modelAnimationIds(modelAsset)
  if (!ids.length) return []
  const skin = modelAssetSkin(modelAsset)
  // A model that names animations but exposes no skeleton is a real defect, not a normal state: the links
  // are listed in the inspector while nothing ever plays. `modelAssetSkin` finds the skeleton by taking the
  // FIRST sub-mesh carrying one, so a model whose skin sits elsewhere — or was lost on a re-save — lands
  // here. Reported rather than swallowed; it is otherwise invisible.
  if (!skin) {
    // Once per model, not once per placement: this is reached from `instantiateModelAsset`, so a scene with
    // fifty copies of the character would otherwise log fifty identical lines on every open and resync.
    if (!warnedNoSkin.has(modelAsset.id)) {
      warnedNoSkin.add(modelAsset.id)
      Logger.warn(
        `"${modelAsset.id}" links ${ids.length} animation${ids.length === 1 ? '' : 's'} but has no skeleton ` +
        'to retarget onto, so none of them will play.', 'Editor')
    }
    return []
  }

  const out: StoredClip[] = []
  for (const id of ids) {
    const asset = animations.find(a => a.id === id)
    if (!asset) continue
    out.push(...(resolveAnimationAsset(asset, skin, modelAsset.id, modelAsset.rigId) as unknown as StoredClip[]))
  }
  return out
}

/**
 * Put a model asset's shared clips onto a live subtree's skinned models. Applied to the LIVE node, never
 * to serialized JSON: a resolved clip must not end up in anything that gets saved.
 * Existing clips with the same `assetId` are removed first, so this is idempotent.
 */
export function applyModelAnimations(
  root: Node,
  modelAsset: { id: string; nodeJson: any; animationIds?: string[] },
  animations: AnimationAsset[],
): number {
  const clips = resolveModelAnimations(modelAsset, animations) as unknown as Animation[]
  let count = 0
  const walk = (node: Node) => {
    const model: any = (node as any).model
    if (model instanceof AnimatedModel && model.hasSkin) {
      for (const existing of model.animations.filter((a: Animation) => a.assetId)) model.removeAnimation(existing.name)
      for (const clip of clips) model.addAnimation({ ...clip })
      count++
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  return count
}
