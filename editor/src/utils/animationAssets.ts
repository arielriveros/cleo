// Animation clips as a shared library asset.
//
// An `.anim` asset stores its clips in their ORIGINAL source-rig space together with the skeleton they
// were authored against. Both sides are required: `buildBoneMapping` needs the source skin, so keeping it
// is what lets one asset be retargeted onto any rig, and re-retargeted later if the mapping improves.
//
// Must stay engine-free (no `cleo` import) so it is unit-testable without a GL context; the types below
// are structural restatements of `Animation`/`Skin`.

import { cryptoRandomId } from './ids'

/** {@link Animation}, restated structurally so this module stays engine-free. */
export type StoredClip = {
  name: string
  samplers: { input: number[]; output: number[]; interpolation: string }[]
  channels: { samplerIndex: number; targetNodeIndex: number; targetPath: string }[]
  rootMotion?: boolean
}

/**
 * A {@link Skin} flattened for JSON.
 * `nodeParents`/`nodeTransforms`/`nodeNames` are `Map`s live and must be persisted as ENTRY PAIRS —
 * `JSON.stringify` turns a Map into `{}`. The shape matches `AnimatedModel.serialize` so one reader does both.
 */
export type StoredSkin = {
  name?: string
  joints: { nodeIndex: number; inverseBindMatrix: number[]; parentIndex?: number }[]
  skeleton?: number
  nodeParents?: [number, number][]
  nodeTransforms?: [number, number[]][]
  nodeNames?: [number, string][]
}

export type AnimationAsset = {
  id: string
  name: string
  /** Every clip the source file contained, in SOURCE-rig space. Untouched by any retarget. */
  clips: StoredClip[]
  /** The skeleton `clips` were authored against. Null only for a file that carried no skin at all. */
  sourceSkin: StoredSkin | null
  /** The file this came from, so a re-import can offer the existing asset instead of a second copy. */
  sourceFile?: string
  thumbnail?: string
}

/**
 * Flatten a `Skin` for storage. Must accept BOTH shapes: the import path hands it a live skin (Maps,
 * Float32Arrays) and the migration hands it an already-serialized one (entry pairs, plain arrays).
 * Re-flattening entry pairs as if they were a Map yields a skin with no bone names, which retargets
 * against nothing.
 */
export function storeSkin(skin: any): StoredSkin | null {
  if (!skin) return null
  const pairs = <V,>(m: Map<number, V> | [number, V][] | undefined): [number, V][] | undefined =>
    m instanceof Map ? [...m.entries()] : Array.isArray(m) ? m.map(e => [e[0], e[1]] as [number, V]) : undefined
  return {
    name: skin.name,
    joints: (skin.joints ?? []).map((j: any) => ({
      nodeIndex: j.nodeIndex,
      // Float32Array -> plain array, or it JSON-stringifies as an object keyed by index.
      inverseBindMatrix: Array.from(j.inverseBindMatrix ?? []) as number[],
      parentIndex: j.parentIndex,
    })),
    skeleton: skin.skeleton,
    nodeParents: pairs(skin.nodeParents),
    nodeTransforms: pairs<Float32Array | number[]>(skin.nodeTransforms)?.map(([k, v]) => [k, Array.from(v)] as [number, number[]]),
    nodeNames: pairs(skin.nodeNames),
  }
}

/**
 * Rebuild a live `Skin` from storage. `toMat4` is passed in rather than imported to keep this module
 * engine-free; it must produce a Float32Array, which is what the retarget maths indexes.
 */
export function loadSkin(stored: StoredSkin | null | undefined, toMat4: (a: number[]) => any): any | null {
  if (!stored) return null
  return {
    name: stored.name,
    joints: stored.joints.map(j => ({
      nodeIndex: j.nodeIndex,
      inverseBindMatrix: toMat4(j.inverseBindMatrix),
      parentIndex: j.parentIndex,
    })),
    skeleton: stored.skeleton,
    nodeParents: new Map(stored.nodeParents ?? []),
    nodeTransforms: new Map((stored.nodeTransforms ?? []).map(([k, v]) => [k, toMat4(v)])),
    nodeNames: new Map(stored.nodeNames ?? []),
  }
}

export function buildAnimationAsset(name: string, clips: StoredClip[], sourceSkin: StoredSkin | null, sourceFile?: string, id?: string): AnimationAsset {
  return { id: id ?? cryptoRandomId(), name, clips, sourceSkin, sourceFile }
}

/**
 * A content fingerprint for a clip: everything that affects playback, and nothing else.
 * The name is EXCLUDED — the same download is routinely renamed per character. Keyframe numbers are
 * rounded before hashing so a float32 round trip in one asset and not the other still matches.
 */
export function clipFingerprint(clip: StoredClip): string {
  const q = (n: number) => (Math.abs(n) < 1e-6 ? 0 : Math.round(n * 1e5) / 1e5)
  const samplers = clip.samplers.map(s => `${s.interpolation}|${s.input.map(q).join(',')}|${s.output.map(q).join(',')}`)
  const channels = clip.channels
    .map(c => `${c.samplerIndex}:${c.targetNodeIndex}:${c.targetPath}`)
    .sort()   // channel ORDER is not meaningful; two files can emit the same set in a different order
  return `${channels.join(';')}#${samplers.join(';')}`
}

/** The fingerprint of a whole asset — its clips as a set, so clip order does not split a match. */
export function assetFingerprint(asset: Pick<AnimationAsset, 'clips'>): string {
  return asset.clips.map(clipFingerprint).sort().join('||')
}

/** An existing asset holding exactly these clips, or undefined. Used to avoid a second copy on re-import. */
export function findEquivalentAnimation(assets: AnimationAsset[], clips: StoredClip[]): AnimationAsset | undefined {
  const want = assetFingerprint({ clips })
  return assets.find(a => assetFingerprint(a) === want)
}

/**
 * The animation assets a model asset uses. Stored on the MODEL, not on each placed node, so every
 * instance of a character picks up the same clip list.
 */
export type AnimationRefBearing = { animationIds?: string[] }

export function withAnimationRef<T extends AnimationRefBearing>(asset: T, animationId: string): T {
  const ids = asset.animationIds ?? []
  if (ids.includes(animationId)) return asset
  return { ...asset, animationIds: [...ids, animationId] }
}

export function withoutAnimationRef<T extends AnimationRefBearing>(asset: T, animationId: string): T {
  const ids = asset.animationIds ?? []
  if (!ids.includes(animationId)) return asset
  return { ...asset, animationIds: ids.filter(id => id !== animationId) }
}

/**
 * One-shot migration: lift every clip embedded in a model asset into a shared `.anim` asset. Identical
 * clips collapse onto one asset, matched on CONTENT rather than name.
 *
 * Three properties make it safe over existing projects:
 *  - a model with no skin, or no clips, comes back as the SAME object, so nothing else is rewritten;
 *  - extracted clips keep their names, because state machines and Animation Field samples reference
 *    clips BY NAME;
 *  - each new asset records the MODEL'S OWN skin as its source, so re-resolving onto that model is an
 *    identity retarget.
 *
 * Pure: takes the libraries, returns new ones. The caller decides whether to persist.
 */
export function extractEmbeddedClips<M extends { id: string; name: string; nodeJson: any; animationIds?: string[] }>(
  models: M[],
  existing: AnimationAsset[],
  skinnedModelJson: (nodeJson: any) => any | null,
  stripClips: (asset: M) => M,
): { models: M[]; animations: AnimationAsset[]; extracted: number; shared: number } {
  const animations = [...existing]
  // Fingerprint -> asset, so a second character carrying the same walk links rather than copies.
  const byPrint = new Map<string, AnimationAsset>()
  for (const a of animations) for (const c of a.clips) byPrint.set(clipFingerprint(c), a)

  let extracted = 0
  let shared = 0
  const outModels = models.map(model => {
    const json = skinnedModelJson(model.nodeJson)
    const clips: StoredClip[] = json?.animations ?? []
    if (!json?.skin || !clips.length) return model

    const skin = storeSkin(json.skin)
    let next = model
    for (const clip of clips) {
      const print = clipFingerprint(clip)
      let asset = byPrint.get(print)
      if (asset) shared++
      else {
        // Named after the clip, not the model: that is the name every state machine already says.
        asset = buildAnimationAsset(clip.name || 'clip', [clip], skin)
        animations.push(asset)
        byPrint.set(print, asset)
        extracted++
      }
      next = withAnimationRef(next, asset.id)
    }
    // Strip only once the references are in place, so a throw part-way cannot lose clips.
    return stripClips(next)
  })

  return { models: outModels, animations, extracted, shared }
}
