// A game's shared animation clips as publish ships them (game.bin `animations`, `modelAnimations`, `retargets`)
// and as the player reads them back (player/animations.ts). Its own module, free of editor state, so the NetSync
// host can build a game from an example folder with the same rules.

import { sourceSkinFor } from '../../utils/rigAssets'
import { posesForRig } from '../../utils/poseAssets'
import type { AssetLibs } from '../../utils/assetHash'

/**
 * A game's shared animation data, as the player reads it (player/animations.ts): the clips the shipped models
 * play, once, in their source rig's space (`animations`), which model asset plays which (`modelAnimations`), and
 * the rig retarget corrections flattened to (model, animation) pairs (`retargets`, absent when there are none).
 */
export function sharedAnimationData(libs: AssetLibs): { animations: any[]; modelAnimations: Record<string, string[]>; retargets?: Record<string, Record<string, unknown[]>> } {
  // Shared animation clips ONCE for the whole game, in their source rig's space, plus a map of which model
  // asset uses which. `AnimatedModel.serialize` drops an asset-backed clip, so the scenes above carry
  // none; the player resolves and retargets at load. Narrowed to what a shipped model references.
  const modelAnimations: Record<string, string[]> = {}
  const wantedAnims = new Set<string>()
  // EXPANDED from rig -> models at pack time. Clips are owned by the rig now, but the player looks them up
  // per MODEL (`byModel[modelIdOf(node)]`), so flattening here keeps the pack format and the player
  // untouched — the same trick used just below for `sourceSkin`.
  const rigClips = new Map((libs.rigs ?? []).map(r => [r.id, r.animationIds ?? []]))
  for (const m of libs.models ?? []) {
    const ids = m.rigId ? rigClips.get(m.rigId) ?? [] : []
    const unique = [...new Set(ids)]
    if (!unique.length) continue
    modelAnimations[m.id] = unique
    for (const id of unique) wantedAnims.add(id)
  }
  // FLATTEN the rig back into each shipped animation.
  //
  // `player/animations.ts` retargets using `asset.sourceSkin`; with no skeleton on the asset it falls
  // through to playing the clips UNRETARGETED — silently wrong animation in the published game, with
  // nothing logged. New assets carry `rigId` instead of an embedded skin, so publish resolves it here.
  // Deliberately not a `rigs` table in the pack: that would be a runtime format change (and a player
  // rebuild) for a bundle that is a flattened artifact anyway.
  //
  // The rig's shared POSES ride along for the same reason. A clip's `poseOffset` edit names one by id and
  // `applyClipEdits` resolves it against the SOURCE rig — which is not shipped — so without this the
  // published game plays every posed clip with its offset silently missing. Same failure mode as the
  // skeleton above, and just as invisible: the clip still plays, it is simply not the clip the artist saw.
  const animations = (libs.animations ?? [])
    .filter(a => wantedAnims.has(a.id))
    .map(a => {
      const rig = a.rigId ? (libs.rigs ?? []).find(r => r.id === a.rigId) : undefined
      const withSkin = { ...a, sourceSkin: sourceSkinFor(a, libs.rigs ?? []) }
      // Pose ASSETS on the rig resolve the same pose ids as its legacy list, so both ship.
      const poses = posesForRig(rig, libs.poseAssets ?? [])
      return poses.length ? { ...withSkin, poses } : withSkin
    })

  // Flatten the rig-level retarget corrections into the (model, animation) pair the player can index.
  // Stored on the target rig keyed by SOURCE rig; the player has a model and an animation, so publish
  // resolves the two hops here rather than shipping a rig table.
  const retargets: Record<string, Record<string, unknown[]>> = {}
  for (const m of libs.models ?? []) {
    // The model's OWN skeleton's rig: the corrections map onto it, also while it plays another skeleton.
    const rigId = (m as { nativeRigId?: string }).nativeRigId ?? m.rigId
    const rig = rigId ? (libs.rigs ?? []).find(r => r.id === rigId) : undefined
    if (!rig?.retargets) continue
    for (const id of modelAnimations[m.id] ?? []) {
      const sourceRigId = animations.find(a => a.id === id)?.rigId
      const overrides = sourceRigId ? rig.retargets[sourceRigId] : undefined
      if (!overrides?.length) continue
      ;(retargets[m.id] ??= {})[id] = overrides
    }
  }
  return Object.keys(retargets).length ? { animations, modelAnimations, retargets } : { animations, modelAnimations }
}
