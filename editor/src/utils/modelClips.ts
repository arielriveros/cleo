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
