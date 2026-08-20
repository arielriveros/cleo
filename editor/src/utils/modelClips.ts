// ---------------------------------------------------------------------------------------------------
// Skeleton + animation clips belong to the MODEL ASSET, and this is the serialized half of that.
//
// A template (or a scene) stores a full serialized copy of the subtree it contains, but the copy carries a
// `__modelId` back-link. That link is what makes the asset — not the copy — the place clips live: importing
// an animation while editing a template has to reach the character everywhere it is placed, not just that
// template's private copy.
//
// These functions patch an asset's `nodeJson`; the LIVE half is patched through AnimatedModel's own
// addAnimation/removeAnimation/renameAnimation (see refreshModelClips in models.ts), which need no GPU
// rebuild. Both halves have to move together, which is why the de-duping below deliberately mirrors
// AnimatedModel's.
//
// Deliberately engine-free — no `cleo` import — so it is unit-testable from the root test suite, which
// cannot resolve the editor's `cleo` → ../dist link.
// ---------------------------------------------------------------------------------------------------

/** The shape these helpers need from a model asset. Structural, so ModelAsset satisfies it. */
export type ClipBearingAsset = { nodeJson: any }

/**
 * The first serialized SKINNED model inside a nodeJson subtree, or null.
 *
 * Not the root: an imported model's root is a plain holder Node ("a parent Node holding one ModelNode per
 * sub-mesh", see parseBundleToRoot) and the skinned model hangs off a child of it.
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
  const nodeJson = JSON.parse(JSON.stringify(asset.nodeJson))
  const model = skinnedModelJsonOf(nodeJson)
  if (!model) return asset
  const before = model.animations ?? []
  const next = mutate(before)
  // Hand the ORIGINAL back when nothing actually changed. Callers feed the result to updateModel, and a
  // new-but-equal object would mark the library dirty and trigger a full IndexedDB rewrite for a no-op.
  if (next === before) return asset
  // AnimatedModel.serialize writes `null` rather than [] for an empty list; match it, so a round-trip
  // through the asset produces the JSON the engine itself would have written.
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
 * Toggle root motion on a clip in an asset's serialized model. A name that is not there, or a value that
 * matches what the clip already carries, leaves the asset untouched (withClips returns the original on no-op).
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
 *
 * The serialized skin stores `nodeNames` as entry PAIRS (`[number, string][]`) — a Map does not survive
 * JSON — which is the shape AnimatedModel.parse reads back.
 */
export function assetWithBoneNames<T extends ClipBearingAsset>(asset: T, names: Map<number, string>): T {
  const nodeJson = JSON.parse(JSON.stringify(asset.nodeJson))
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
 *
 * The rig belongs to the SKELETON — it is joint indices into this skin and cannot mean anything for another
 * one — so it lands beside `nodeNames` rather than on any placed node, and reaches every instance of the
 * model through the same propagation clips use.
 *
 * Unlike `nodeNames` this replaces rather than merges: a rig is one document that the editor edits whole,
 * and merging a half-assigned chain into a complete one would produce a rig nobody authored.
 */
export function assetWithIkRig<T extends ClipBearingAsset>(asset: T, rig: any | null): T {
  const current = assetIkRig(asset)
  // Hand the ORIGINAL back on a no-op. Callers feed the result to updateModel, and a new-but-equal object
  // marks the library dirty and triggers a full IndexedDB rewrite for nothing.
  if (JSON.stringify(current ?? null) === JSON.stringify(rig ?? null)) return asset

  const nodeJson = JSON.parse(JSON.stringify(asset.nodeJson))
  const model = skinnedModelJsonOf(nodeJson)
  if (!model?.skin) return asset
  // `null` rather than `undefined`, matching what AnimatedModel.serialize writes for an absent rig — so a
  // round-trip through the asset produces the JSON the engine itself would have.
  model.skin.ikRig = rig ?? null
  return { ...asset, nodeJson }
}

/** The IK rig an asset carries, or null. */
export function assetIkRig(asset: ClipBearingAsset | undefined): any | null {
  return skinnedModelJsonOf(asset?.nodeJson)?.skin?.ikRig ?? null
}

/**
 * Collapse a model asset's redundant holder node into its single ModelNode.
 *
 * An import used to always produce `holder -> ModelNode`, so a single-mesh character showed up in the
 * Scene panel as two identically-named rows (three, with the per-tab container that openMeshTab added on
 * top). The holder exists for three reasons and all of them survive the collapse:
 *  - it carries the fit-to-size factor for a RIGGED import, which cannot be baked into skinned vertices —
 *    folded into the child's scale/position here, and the renderer applies a skinned node's own world
 *    transform, so it keeps working;
 *  - it carries `__modelId` on a placed instance — `modelInstanceRootOf` and `skinnedModelNodeOf` are both
 *    self-inclusive, so the id landing on the ModelNode resolves identically;
 *  - it groups a MULTI-part model, which is why >1 child is left alone.
 *
 * Deliberately conservative: a holder with a non-zero ROTATION is left as-is. Composing an arbitrary
 * rotation with a child's TRS needs matrix decomposition (and is ambiguous under non-uniform scale), while
 * every holder this actually targets is either identity or uniformly scaled. Returns the SAME object when
 * nothing changed, so a caller can skip a pointless rewrite.
 *
 * Engine-free, like the rest of this module, so it is unit-testable without a GL context.
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
    // mesh name, which for a single-part import is usually the same string anyway.
    name: nodeJson.name ?? child.name,
    // With no holder rotation this is exact: scale composes componentwise and the child's offset is scaled
    // by the holder before being added to it.
    position: [hp[0] + hs[0] * cp[0], hp[1] + hs[1] * cp[1], hp[2] + hs[2] * cp[2]],
    scale: [hs[0] * cs[0], hs[1] * cs[1], hs[2] * cs[2]],
    // Holder variables win only where the child has none — the child is the node being kept.
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
  const nodeJson = JSON.parse(JSON.stringify(asset.nodeJson))
  const target = skinnedModelJsonOf(nodeJson)
  if (target) target.animations = null   // null, not [], to match what AnimatedModel.serialize writes
  return { ...asset, nodeJson }
}
