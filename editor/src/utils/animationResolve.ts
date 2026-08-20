// Resolving shared animation assets onto a concrete rig.
//
// An `.anim` asset stores its clips in the SOURCE rig's space (see animationAssets.ts). Turning one into
// clips a given character can play means retargeting it against that character's skeleton — which is why
// the asset carries the source skin, and why this step happens at USE rather than at import. One stored
// walk, any number of characters.
//
// Unlike animationAssets.ts this module needs the engine (the retarget maths lives there), so it is kept
// separate to leave the storage half unit-testable without a GL context.

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
 *
 * Reads the asset rather than a live node on purpose: the rig has to be known to retarget against, and at
 * import time (or when resolving a placement) there may be no instance of that character in the scene at
 * all. The serialized shape is the one `AnimatedModel.serialize` writes, so this and `AnimatedModel.parse`
 * read the same bytes.
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
 *
 * `cacheKey` should identify the target rig (the model asset id). Pass `undefined` to bypass the cache —
 * appropriate when the target skin is a one-off, such as a preview built from an unsaved edit.
 *
 * An asset with no source skin cannot be retargeted at all: the clips are returned untouched, which is
 * right for the only way that happens — a file whose skeleton the loader could not recover, where the
 * channels are already in the target's node-index space or nothing will match either way.
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
    // ONE mapping for the whole asset — every clip in it shares the source skeleton, exactly as the import
    // review modal treats a file.
    const mapping = buildBoneMapping(clips, sourceSkin, targetSkin)
    out = clips.map(c => retargetAnimation(c, sourceSkin, targetSkin, mapping))
  }
  // Stamp the origin. AnimatedModel.serialize drops a clip carrying one, so a resolved clip plays but is
  // never written into a scene, a template or the published game — it is restored by resolving again.
  out = out.map(c => ({ ...c, assetId: asset.id }))
  if (key) cache.set(key, out)
  return out
}

/**
 * Every clip a model asset's `animationIds` resolve to, in order, ready to hand to `addAnimation`.
 *
 * Ids that name a deleted asset are skipped silently: the library is the source of truth, and a model
 * holding a stale id is the normal result of deleting an animation while the model is not loaded.
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
 * Put a model asset's shared clips onto a live subtree's skinned models.
 *
 * The counterpart to `resolveMaterialRefs`, but applied to the LIVE node rather than to the serialized
 * JSON — a resolved clip must not end up in anything that gets saved. Existing clips carrying the same
 * `assetId` are removed first, so this is idempotent and a re-resolve after an edit replaces cleanly.
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
