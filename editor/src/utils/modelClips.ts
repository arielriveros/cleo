// ---------------------------------------------------------------------------------------------------
// Skeleton + animation clips belong to the MODEL ASSET; this is the serialized half of that. A template or
// scene stores its own copy of the subtree, but the `__modelId` back-link makes the ASSET where clips live.
//
// These functions patch an asset's `nodeJson`. The LIVE half goes through AnimatedModel's
// addAnimation/removeAnimation/renameAnimation (see refreshModelClips in models.ts), and both halves must
// move together — which is why the de-duping below mirrors AnimatedModel's exactly.
//
// Must stay engine-free (no `cleo` import) so the root test suite, which cannot resolve the editor's
// `cleo` → ../dist link, can exercise it.
// ---------------------------------------------------------------------------------------------------

import { deepClone } from './deepClone'

/** The shape these helpers need from a model asset. Structural, so ModelAsset satisfies it. */
export type ClipBearingAsset = { nodeJson: any }

/**
 * The first serialized SKINNED model inside a nodeJson subtree, or null.
 * Never the root: an imported model's root is a plain holder Node and the skinned model hangs off a child.
 */
export function skinnedModelJsonOf(nodeJson: any): any | null {
  if (!nodeJson || typeof nodeJson !== 'object') return null
  if (nodeJson.model?.skin) return nodeJson.model
  for (const child of nodeJson.children ?? []) {
    const found = skinnedModelJsonOf(child)
    if (found) return found
  }
  return null
}

/** A name not already in `taken`, suffixing ' (2)', ' (3)', … exactly as AnimatedModel.addAnimation does. */
export function uniqueClipName(name: string, taken: Set<string>): string {
  const base = name || 'clip'
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} (${n})`)) n++
  return `${base} (${n})`
}

/**
 * Rewrite an asset's clip list through `mutate`, returning a NEW asset (or the original when there is no
 * skinned model to patch). The input is never modified — asset libraries are React state.
 */
function withClips<T extends ClipBearingAsset>(asset: T, mutate: (clips: any[]) => any[]): T {
  const nodeJson = deepClone(asset.nodeJson)
  const model = skinnedModelJsonOf(nodeJson)
  if (!model) return asset
  const before = model.animations ?? []
  const next = mutate(before)
  // Hand the ORIGINAL back on a no-op: a new-but-equal object marks the library dirty and triggers a full
  // IndexedDB rewrite.
  if (next === before) return asset
  // AnimatedModel.serialize writes `null`, not [], for an empty list; a round trip must match it.
  model.animations = next.length ? next : null
  return { ...asset, nodeJson }
}

/** Add a clip to an asset's serialized model, de-duping its name. */
export function assetWithClipAdded<T extends ClipBearingAsset>(asset: T, clip: any): T {
  return withClips(asset, clips => {
    const name = uniqueClipName(clip?.name, new Set(clips.map((c: any) => c.name)))
    return [...clips, { ...clip, name }]
  })
}

/** Rename a clip in an asset's serialized model. A name that is not there leaves the asset untouched. */
export function assetWithClipRenamed<T extends ClipBearingAsset>(asset: T, oldName: string, newName: string): T {
  return withClips(asset, clips => {
    if (!clips.some((c: any) => c.name === oldName)) return clips
    const wanted = (newName || '').trim() || oldName
    const name = wanted === oldName
      ? oldName
      : uniqueClipName(wanted, new Set(clips.filter((c: any) => c.name !== oldName).map((c: any) => c.name)))
    return clips.map((c: any) => c.name === oldName ? { ...c, name } : c)
  })
}

/** Remove a clip from an asset's serialized model. */
export function assetWithClipRemoved<T extends ClipBearingAsset>(asset: T, name: string): T {
  return withClips(asset, clips => clips.filter((c: any) => c.name !== name))
}

/**
 * Toggle root motion on a clip in an asset's serialized model. An unknown name, or a value the clip already
 * carries, leaves the asset untouched.
 */
export function assetWithClipRootMotion<T extends ClipBearingAsset>(asset: T, name: string, on: boolean): T {
  return withClips(asset, clips => {
    const clip = clips.find((c: any) => c.name === name)
    if (!clip || !!clip.rootMotion === on) return clips
    return clips.map((c: any) => c.name === name ? { ...c, rootMotion: on } : c)
  })
}

/**
 * Merge bone names into an asset's serialized skin, so animation import can match by name from then on.
 * The serialized skin stores `nodeNames` as entry PAIRS (`[number, string][]`), the shape
 * AnimatedModel.parse reads back.
 */
export function assetWithBoneNames<T extends ClipBearingAsset>(asset: T, names: Map<number, string>): T {
  const nodeJson = deepClone(asset.nodeJson)
  const model = skinnedModelJsonOf(nodeJson)
  if (!model?.skin) return asset
  const merged = new Map<number, string>(
    (model.skin.nodeNames ?? []).map((e: any) => [Number(e[0]), String(e[1])] as [number, string]),
  )
  for (const [index, name] of names) merged.set(index, name)
  model.skin.nodeNames = Array.from(merged.entries())
  return { ...asset, nodeJson }
}

/** The clip names an asset carries, in order. */
export function assetClipNames(asset: ClipBearingAsset | undefined): string[] {
  const model = skinnedModelJsonOf(asset?.nodeJson)
  return (model?.animations ?? []).map((c: any) => c?.name).filter(Boolean)
}

/**
 * Write an IK rig into an asset's serialized skin. `null` clears it.
 * The rig is joint indices into THIS skin, so it lands beside `nodeNames` rather than on a placed node.
 * Unlike `nodeNames` it replaces rather than merges: merging a half-assigned chain into a complete one
 * would produce a rig nobody authored.
 */
export function assetWithIkRig<T extends ClipBearingAsset>(asset: T, rig: any | null): T {
  const current = assetIkRig(asset)
  // Hand the ORIGINAL back on a no-op: a new-but-equal object triggers a full IndexedDB rewrite.
  if (JSON.stringify(current ?? null) === JSON.stringify(rig ?? null)) return asset

  const nodeJson = deepClone(asset.nodeJson)
  const model = skinnedModelJsonOf(nodeJson)
  if (!model?.skin) return asset
  // `null`, not `undefined`, matching what AnimatedModel.serialize writes for an absent rig.
  model.skin.ikRig = rig ?? null
  return { ...asset, nodeJson }
}

/** The IK rig an asset carries, or null. */
export function assetIkRig(asset: ClipBearingAsset | undefined): any | null {
  return skinnedModelJsonOf(asset?.nodeJson)?.skin?.ikRig ?? null
}

/**
 * Collapse a model asset's redundant holder node into its single ModelNode, so a single-mesh character is
 * one row in the Scene panel rather than two. Everything the holder carried survives: its fit-to-size
 * factor folds into the child's scale/position, and `__modelId` resolves the same on the ModelNode because
 * `modelInstanceRootOf` and `skinnedModelNodeOf` are self-inclusive. A holder with >1 child groups a
 * multi-part model and is left alone.
 *
 * A holder with a non-zero ROTATION is also left alone: composing it with the child's TRS needs matrix
 * decomposition and is ambiguous under non-uniform scale.
 * Returns the SAME object when nothing changed, so a caller can skip a pointless rewrite.
 */
export function flattenModelJson(nodeJson: any): any {
  if (!nodeJson || nodeJson.type === 'model' || nodeJson.type === 'mesh') return nodeJson
  const children = nodeJson.children
  if (!Array.isArray(children) || children.length !== 1) return nodeJson

  const child = children[0]
  if (!child || !child.model) return nodeJson                       // not a ModelNode: leave the structure alone
  if (nodeJson.script || nodeJson.body || nodeJson.trigger) return nodeJson

  const rot = nodeJson.rotation ?? [0, 0, 0]
  if (rot.some((r: number) => Math.abs(r) > 1e-6)) return nodeJson  // see the note above

  const hs = nodeJson.scale ?? [1, 1, 1]
  const hp = nodeJson.position ?? [0, 0, 0]
  const cs = child.scale ?? [1, 1, 1]
  const cp = child.position ?? [0, 0, 0]

  const flat = {
    ...child,
    // The holder's name is the asset's name and the one the user sees; the child's is the file's internal
    // mesh name.
    name: nodeJson.name ?? child.name,
    // Exact only because the holder is unrotated: scale composes componentwise and the child's offset is
    // scaled by the holder before being added.
    position: [hp[0] + hs[0] * cp[0], hp[1] + hs[1] * cp[1], hp[2] + hs[2] * cp[2]],
    scale: [hs[0] * cs[0], hs[1] * cs[1], hs[2] * cs[2]],
    // Holder variables win only where the child has none; the child is the node being kept.
    variables: { ...(nodeJson.variables ?? {}), ...(child.variables ?? {}) },
  }
  if (!Object.keys(flat.variables).length) delete flat.variables
  return flat
}

/** {@link flattenModelJson} applied to a whole asset. Returns the SAME asset when nothing changed. */
export function flattenModelAsset<T extends { nodeJson: any }>(asset: T): T {
  const nodeJson = flattenModelJson(asset.nodeJson)
  return nodeJson === asset.nodeJson ? asset : { ...asset, nodeJson }
}

/** A model asset with the clips removed from its serialized subtree. Same object when it had none. */
export function assetWithoutEmbeddedClips<T extends ClipBearingAsset>(asset: T): T {
  const model = skinnedModelJsonOf(asset.nodeJson)
  if (!model?.animations?.length) return asset
  const nodeJson = deepClone(asset.nodeJson)
  const target = skinnedModelJsonOf(nodeJson)
  if (target) target.animations = null   // null, not [], to match what AnimatedModel.serialize writes
  return { ...asset, nodeJson }
}

/**
 * The `[px,py,pz, rx,ry,rz, sx,sy,sz]` of a serialized node, defaulting to an identity transform.
 * Engine-free half of the model-transform propagation (see applyModelTransformDelta in models.ts).
 */
export function nodeJsonTrs(nodeJson: any): number[] {
  const triple = (v: any, d: number) => {
    const a = Array.isArray(v) ? v : []
    // `a[i] == null` must be tested first: Number(null) is 0, so a null component reads as a zero SCALE.
    return [0, 1, 2].map(i => (a[i] == null || !Number.isFinite(Number(a[i])) ? d : Number(a[i])))
  }
  return [...triple(nodeJson?.position, 0), ...triple(nodeJson?.rotation, 0), ...triple(nodeJson?.scale, 1)]
}

/**
 * A placement's transform with the change its MODEL made to its own root transform applied on top.
 *
 * The asset's TRS at the time the copy was built (MODEL_BASE_TRS_VAR) turns this into a subtraction, done
 * component-wise: `pos += new - base`, `rot += new - base`, `scale *= new / base`. Exact whenever the model
 * root is unrotated; an approximation under simultaneous rotation and non-uniform scale.
 * Returns null when there is no baseline or nothing moved, so the caller can skip the write.
 */
export function modelTransformDelta(
  instance: { position: ArrayLike<number>; rotation: ArrayLike<number>; scale: ArrayLike<number> },
  base: number[] | null | undefined,
  next: number[],
): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } | null {
  if (!Array.isArray(base) || base.length < 9) return null
  if (base.every((v, i) => Math.abs(v - next[i]) < 1e-6)) return null

  const p = instance.position, r = instance.rotation, s = instance.scale
  // A zero base scale carries no ratio; treat it as 1 or the copy collapses to NaN.
  const ratio = (i: number) => (Math.abs(base[6 + i]) < 1e-6 ? 1 : next[6 + i] / base[6 + i])
  return {
    position: [p[0] + (next[0] - base[0]), p[1] + (next[1] - base[1]), p[2] + (next[2] - base[2])],
    rotation: [r[0] + (next[3] - base[3]), r[1] + (next[4] - base[4]), r[2] + (next[5] - base[5])],
    scale: [s[0] * ratio(0), s[1] * ratio(1), s[2] * ratio(2)],
  }
}
