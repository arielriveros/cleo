// Resolving shared animation assets onto a concrete rig.
//
// An `.anim` asset stores its clips in the SOURCE rig's space (see animationAssets.ts), so playing one on
// a character means retargeting against that character's skeleton — at USE, not at import, which is what
// lets one stored walk serve any number of characters.
//
// This module needs the engine (the retarget maths lives there); it is split from animationAssets.ts to
// leave the storage half unit-testable without a GL context.

import { mat4 } from 'gl-matrix'
import { AnimatedModel, buildBoneMapping, retargetAnimation, Logger, type Animation, type Node, type Skin } from 'cleo'
import { loadSkin, type AnimationAsset, type StoredClip, type StoredSkin } from './animationAssets'
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
 * How to look up a rig's skeleton by id.
 *
 * A module-level registration rather than a `rigs: RigAsset[]` parameter threaded through
 * `resolveAnimationAsset` -> `resolveModelAnimations` -> `applyModelAnimations` -> `refreshModelClips` ->
 * `instantiateModelAsset` and their call sites — the same shape `registerFoliageSourceResolver` and
 * `registerTemplates` already use for a cross-cutting dependency this module cannot own.
 */
let rigResolver: ((rigId: string) => StoredSkin | null) | null = null

export function registerRigResolver(fn: ((rigId: string) => StoredSkin | null) | null): void {
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
  const stored = (asset.rigId ? rigResolver?.(asset.rigId) : null) ?? asset.sourceSkin ?? null
  return stored ? (loadSkin(stored, toMat4) as Skin) : null
}

/** A per-session cache: the retarget is deterministic, so the same pair never needs computing twice. */
const cache = new Map<string, Animation[]>()

/** Models already reported as having no skeleton — see resolveModelAnimations. Cleared with the cache. */
const warnedNoSkin = new Set<string>()

/** Drop everything cached for one animation asset — call when its clips change or it is deleted. */
export function invalidateAnimationCache(animationId?: string): void {
  if (!animationId) { cache.clear(); warnedNoSkin.clear(); return }
  for (const key of [...cache.keys()]) if (key.startsWith(`${animationId}:`)) cache.delete(key)
}

/**
 * The clips `asset` contributes to a model, retargeted onto `targetSkin`.
 * `cacheKey` must identify the target rig (the model asset id); pass `undefined` to bypass the cache, as
 * for a preview built from an unsaved edit.
 * An asset with no source skin cannot be retargeted, so its clips are returned untouched.
 */
export function resolveAnimationAsset(asset: AnimationAsset, targetSkin: Skin, cacheKey?: string): Animation[] {
  const key = cacheKey ? `${asset.id}:${cacheKey}` : ''
  if (key) { const hit = cache.get(key); if (hit) return hit }

  const clips = asset.clips as unknown as Animation[]
  const sourceSkin = sourceSkinOf(asset)

  let out: Animation[]
  if (!sourceSkin) {
    out = clips.map(c => ({ ...c }))
  } else {
    // ONE mapping for the whole asset: every clip in it shares the source skeleton.
    const mapping = buildBoneMapping(clips, sourceSkin, targetSkin)
    out = clips.map(c => retargetAnimation(c, sourceSkin, targetSkin, mapping))
  }
  // Stamp the origin: AnimatedModel.serialize drops a clip carrying one, so a resolved clip plays but is
  // never written into a scene, a template or the published game.
  out = out.map(c => ({ ...c, assetId: asset.id }))
  if (key) cache.set(key, out)
  return out
}

/**
 * Every clip a model asset's `animationIds` resolve to, in order, ready to hand to `addAnimation`.
 * An id naming a deleted asset is skipped silently; the library is the source of truth.
 */
export function resolveModelAnimations(
  modelAsset: { id: string; nodeJson: any; animationIds?: string[] },
  animations: AnimationAsset[],
): StoredClip[] {
  const ids = modelAsset.animationIds
  if (!ids?.length) return []
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
    out.push(...(resolveAnimationAsset(asset, skin, modelAsset.id) as unknown as StoredClip[]))
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
