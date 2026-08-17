import type { MaterialAsset } from './materials'
import type { ModelAsset } from './models'
import type { Template } from './templates'
import type { TerrainMaterialAsset } from './terrainMaterials'
import type { ScriptAsset } from './scripts'
import type { TilesetAsset } from './tilesets'

// Content hashes let a closed scene decide, when it is next opened, whether each asset it references
// actually changed since the scene was saved — so unchanged models/templates aren't needlessly
// re-instantiated (which would churn node ids and drop per-instance state). The hash is stable across
// reloads: it is computed purely from the asset's serialized content, minus its thumbnail (a thumbnail
// re-render must not read as a content change).

/** 32-bit FNV-1a over a string, returned as an 8-char hex. Fast, dependency-free, good enough to gate. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // h *= 16777619, kept in 32-bit range via the shift-add form to avoid float precision loss.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Fields that must NOT count as a content change.
 *
 * `thumbnail` is the obvious one — a re-render is not an edit. The two skeleton fields matter for a subtler
 * reason: they are metadata ABOUT a skeleton rather than part of it, they are pushed to every live instance
 * in place by propagateModelClips, and they also ride each placed node's own serialized skin. So a rebuild
 * gains nothing — and costs everything, because re-instantiating a placement drops the per-node state the
 * asset knows nothing about. Assigning an IK rig used to wipe every placed character's animation state
 * machine through exactly this route.
 *
 * The bar for this list is "changing it cannot alter what instantiating the asset produces STRUCTURALLY".
 * Geometry, materials, hierarchy and clip lists all fail that bar and must stay hashed.
 */
const NON_STRUCTURAL_KEYS = new Set(['thumbnail', 'ikRig', 'nodeNames'])

/**
 * Bump this whenever {@link hashAsset} changes what it hashes.
 *
 * A stored hash is only comparable against one produced by the SAME function. Change the function — add a key
 * to the exclusion set above, say — and every hash in every saved scene stops matching, so `resyncScene`
 * reads "every asset changed" and re-instantiates every placed template and character in the project at once.
 * That is not a cosmetic churn: a rebuild reconstructs a placement from its asset, and the asset does not know
 * how that placement was configured.
 *
 * Versioning turns that from a silent mass rebuild into a no-op: a scene saved under a different version has
 * hashes we cannot interpret, and the honest reading of "I cannot tell whether this changed" is to leave the
 * scene alone rather than to rebuild all of it.
 *
 * 1 = thumbnail only (original). 2 = thumbnail + ikRig + nodeNames.
 */
export const ASSET_HASH_VERSION = 2

/**
 * Whether a scene's stored hashes can be compared against ones produced by the CURRENT {@link hashAsset}.
 *
 * Three cases, and the middle one is the whole reason this exists:
 *   - no hashes at all — a legacy blob from before hashing, which has never had the propagation applied and
 *     genuinely does mean "resync everything". Comparable: `changedSince` has nothing to match and says yes.
 *   - hashes from a different version — unreadable. Every lookup would miss and read as "changed", rebuilding
 *     every placed template and character in the project at once. NOT comparable: leave the scene alone.
 *   - hashes from this version — compare them.
 *
 * Absent version defaults to 1: scenes saved before the field existed were hashed by the original function.
 */
export function hashesComparable(
  savedHashes: Record<string, string> | undefined,
  savedVersion: number | undefined,
): boolean {
  if (!savedHashes) return true
  return (savedVersion ?? 1) === ASSET_HASH_VERSION
}

/** Deep-stringify `obj` with the non-structural fields omitted at every level, then hash it. */
export function hashAsset(obj: any): string {
  const json = JSON.stringify(obj, (key, value) => (NON_STRUCTURAL_KEYS.has(key) ? undefined : value))
  return fnv1a(json ?? '')
}

export interface AssetLibs {
  materials: MaterialAsset[]
  models: ModelAsset[]
  templates: Template[]
  terrainMaterials: TerrainMaterialAsset[]
  scripts: ScriptAsset[]
  tilesets: TilesetAsset[]
}

/** The hash-map key for an asset of a given kind. Kept in one place so save and resync agree. */
export function assetHashKey(kind: 'material' | 'model' | 'template' | 'terrainMaterial' | 'script' | 'tileset', id: string): string {
  return `${kind}:${id}`
}

/**
 * Content hashes keyed "kind:id" for every asset id the just-referenced sets contain. Callers pass the
 * referenced-id sets (from references.ts collectReferenced* run on the live scene) so only assets the
 * scene actually uses are hashed and stored.
 */
export function buildAssetHashes(
  refs: { materialIds: Set<string>; modelIds: Set<string>; templateIds: Set<string>; terrainMaterialIds: Set<string>; scriptIds?: Set<string>; tilesetIds?: Set<string> },
  libs: AssetLibs,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of libs.materials) if (refs.materialIds.has(m.id)) out[assetHashKey('material', m.id)] = hashAsset(m)
  for (const m of libs.models) if (refs.modelIds.has(m.id)) out[assetHashKey('model', m.id)] = hashAsset(m)
  for (const t of libs.templates) if (refs.templateIds.has(t.id)) out[assetHashKey('template', t.id)] = hashAsset(t)
  for (const t of libs.terrainMaterials) if (refs.terrainMaterialIds.has(t.id)) out[assetHashKey('terrainMaterial', t.id)] = hashAsset(t)
  for (const s of libs.scripts) if (refs.scriptIds?.has(s.id)) out[assetHashKey('script', s.id)] = hashAsset(s)
  for (const t of libs.tilesets ?? []) if (refs.tilesetIds?.has(t.id)) out[assetHashKey('tileset', t.id)] = hashAsset(t)
  return out
}
