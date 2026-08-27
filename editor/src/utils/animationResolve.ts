// Resolving shared animation assets onto a concrete rig.
//
// An `.anim` asset stores its clips in the SOURCE rig's space (see animationAssets.ts), so playing one on
// a character means retargeting against that character's skeleton — at USE, not at import, which is what
// lets one stored walk serve any number of characters.
//
// This module needs the engine (the retarget maths lives there); it is split from animationAssets.ts to
// leave the storage half unit-testable without a GL context.

import { mat4 } from 'gl-matrix'
import { AnimatedModel, buildBoneMapping, retargetAnimation, type Animation, type Node, type Skin } from 'cleo'
import { loadSkin, type AnimationAsset, type StoredClip } from './animationAssets'
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

/** A per-session cache: the retarget is deterministic, so the same pair never needs computing twice. */
const cache = new Map<string, Animation[]>()

/** Drop everything cached for one animation asset — call when its clips change or it is deleted. */
export function invalidateAnimationCache(animationId?: string): void {
  if (!animationId) { cache.clear(); return }
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
  const sourceSkin = asset.sourceSkin ? (loadSkin(asset.sourceSkin, toMat4) as Skin) : null

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
  if (!skin) return []

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
