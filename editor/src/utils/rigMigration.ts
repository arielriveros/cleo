// One-shot migration: lift every model's embedded SKELETON into a shared `.rig` asset, and point existing
// `.anim` assets at the rig they were authored against.
//
// This is the second half of the move that `extractEmbeddedClips` began. That pass gave clips an identity;
// this one gives the SKELETON an identity, which is what the clips need in order to be retargeted reliably:
// before it, both a model and an animation found their skeleton by digging through serialized node JSON and
// taking the first sub-mesh that happened to carry one.
//
// Pure — takes libraries, returns new ones. The caller decides whether to persist. Engine-free, so it is
// unit-testable without a GL context.

import { storeSkin, type AnimationAsset, type StoredSkin } from './animationAssets'
import {
  buildRigAsset, findEquivalentRig, preferRicherSkin, skeletonFingerprint, type RigAsset,
} from './rigAssets'

/** The shape this needs from a model asset. Structural, so `ModelAsset` satisfies it. */
export type RigBearingModel = {
  id: string
  name: string
  nodeJson: any
  rigId?: string
}

export type ExtractRigsResult<M> = {
  models: M[]
  animations: AnimationAsset[]
  rigs: RigAsset[]
  /** How many rigs this pass minted. Zero on a re-run — the idempotence signal. */
  created: number
  linkedModels: number
  linkedAnimations: number
}

/** A name not already taken, suffixing ' (2)', ' (3)', … exactly as the clip namer does. */
function uniqueName(name: string, taken: Set<string>): string {
  const base = name || 'Rig'
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} (${n})`)) n++
  return `${base} (${n})`
}

/**
 * Give every skeleton in the project an identity.
 *
 * Five properties make this safe to run over an existing project, and each is pinned by a test:
 *  - **Idempotent.** The fingerprint index is seeded from the rigs that already exist, so a second run
 *    mints nothing and returns records that are deep-equal to the first run's.
 *  - **Identity-preserving where nothing changes.** A model with no skeleton comes back as the SAME object,
 *    so `writeModelLibrary`'s diff writes nothing for it. Re-writing every model would be a multi-megabyte
 *    IndexedDB churn on a library that did not change.
 *  - **Sharing, not duplicating.** Two characters exported from one armature land on one rig — that is what
 *    makes retargeting between them an identity transform rather than a lossy remap.
 *  - **Never destructive.** `sourceSkin` stays on every animation. It is the fallback when a rig is deleted
 *    and the only thing a build predating rigs can read out of a newer bundle.
 *  - **Richest skin wins.** Two skeletons can fingerprint alike while only one carries bone names or a rest
 *    pose (see `preferRicherSkin`); collapsing onto the poorer one would quietly drop every clip on that
 *    rig to index matching.
 */
export function extractRigs<M extends RigBearingModel>(
  models: M[],
  animations: AnimationAsset[],
  existingRigs: RigAsset[],
  skinnedModelJsons: (nodeJson: any) => any[],
): ExtractRigsResult<M> {
  const rigs = [...existingRigs]
  // fingerprint -> rig. Seeded from what is already there, which is what makes a re-run a no-op.
  const byPrint = new Map<string, RigAsset>()
  for (const rig of rigs) {
    const print = skeletonFingerprint(rig.skin)
    if (print && !byPrint.has(print)) byPrint.set(print, rig)
  }
  const takenNames = new Set(rigs.map(r => r.name))

  let created = 0
  let linkedModels = 0
  let linkedAnimations = 0

  /** The rig for this skeleton — reusing an equivalent one, or minting it. */
  const rigFor = (skin: StoredSkin | null | undefined, name: string): RigAsset | null => {
    const print = skeletonFingerprint(skin)
    // An empty skeleton is not a skeleton. Without this every unskinned model in the project would
    // collapse onto one meaningless shared rig.
    if (!print || !skin) return null

    const existing = byPrint.get(print)
    if (existing) {
      // Fingerprint-equal is not byte-equal: `nodeTransforms` is excluded from the print on purpose, so the
      // incoming copy may carry a rest pose the stored one lacks. Keep whichever retargets better.
      const better = preferRicherSkin(existing.skin, skin)
      if (better !== existing.skin) {
        const upgraded = { ...existing, skin: better }
        rigs[rigs.indexOf(existing)] = upgraded
        byPrint.set(print, upgraded)
        return upgraded
      }
      return existing
    }

    const rig = buildRigAsset(uniqueName(name, takenNames), skin)
    takenNames.add(rig.name)
    rigs.push(rig)
    byPrint.set(print, rig)
    created++
    return rig
  }

  // --- models -----------------------------------------------------------------------------------------
  const outModels = models.map(model => {
    const skins = skinnedModelJsons(model.nodeJson).map(m => m.skin).filter(Boolean)
    if (!skins.length) return model // unchanged OBJECT, so the library diff writes nothing

    // Every distinct skeleton in the model gets a rig, not just the first: a character assembled from a
    // body plus separate hair or armour carries one per part, and an animation authored against the second
    // could otherwise never find a rig to match.
    const minted = skins.map((skin, i) =>
      rigFor(storeSkin(skin) ?? skin, i === 0 ? model.name : `${model.name} ${i + 1}`))

    const primary = minted.find(Boolean)
    if (!primary) return model
    // A model that already names a live rig is left alone — but its ADDITIONAL skeletons are still indexed
    // above, so the animation pass below can match against them.
    if (model.rigId && rigs.some(r => r.id === model.rigId)) return model

    linkedModels++
    return { ...model, rigId: primary.id }
  })

  // --- animations -------------------------------------------------------------------------------------
  const outAnimations = animations.map(anim => {
    if (anim.rigId && rigs.some(r => r.id === anim.rigId)) return anim
    // Named after the CLIP, not a model: an animation may well have arrived before any character using it.
    const rig = rigFor(anim.sourceSkin, anim.name)
    if (!rig) return anim
    linkedAnimations++
    // `sourceSkin` is deliberately kept. See the doc comment above.
    return { ...anim, rigId: rig.id }
  })

  return {
    models: outModels,
    animations: outAnimations,
    rigs,
    created,
    linkedModels,
    linkedAnimations,
  }
}
