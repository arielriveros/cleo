import type { MaterialAsset } from './materials'
import type { ModelAsset } from './models'
import type { Template } from './templates'
import type { TerrainMaterialAsset } from './terrainMaterials'
import type { ScriptAsset } from './scripts'
import type { AnimationAsset } from './animationAssets'
import type { TilesetAsset } from './tilesets'

// Content hashes let a closed scene decide, on its next open, whether each asset it references actually
// changed — so an unchanged model or template is not re-instantiated, which would churn node ids and drop
// per-instance state. Computed purely from the asset's serialized content, so it is stable across reloads.

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
 * Fields that must NOT count as a content change. `ikRig`/`nodeNames` are metadata ABOUT a skeleton,
 * pushed to live instances in place by propagateModelClips, so a rebuild gains nothing and costs the
 * per-node state a placement carries.
 * The bar for this list: changing the field cannot alter what instantiating the asset produces
 * STRUCTURALLY. Geometry, materials, hierarchy and clip lists all fail it and must stay hashed.
 */
const NON_STRUCTURAL_KEYS = new Set(['thumbnail', 'ikRig', 'nodeNames'])

/**
 * Bump this whenever {@link hashAsset} changes what it hashes — including anything that changes the
 * serialized shape it walks, such as a node's key ORDER (JSON.stringify is key-order sensitive).
 *
 * A stored hash is only comparable against one produced by the SAME function. Without the version, a
 * changed function makes every hash miss, `resyncScene` reads "every asset changed", and every placed
 * template and character is re-instantiated from an asset that knows nothing about how it was configured.
 * The version turns that mass rebuild into a no-op instead.
 */
export const ASSET_HASH_VERSION = 4

/**
 * Whether a scene's stored hashes can be compared against ones produced by the CURRENT {@link hashAsset}.
 *   - no hashes at all — comparable; `changedSince` has nothing to match and says "changed", which is the
 *     right reading for a blob saved before hashing existed;
 *   - hashes from a different version — NOT comparable, so the scene is left alone;
 *   - hashes from this version — compare them.
 * An absent version means 1.
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
  /**
   * Shared animation assets. Present so a resync can re-resolve a model's clips, but NOT hashed: changing
   * one changes what plays, never the node tree.
   */
  animations?: AnimationAsset[]
}

/** The hash-map key for an asset of a given kind. Kept in one place so save and resync agree. */
export function assetHashKey(kind: 'material' | 'model' | 'template' | 'terrainMaterial' | 'script' | 'tileset', id: string): string {
  return `${kind}:${id}`
}

/**
 * Content hashes keyed "kind:id" for every asset id in the referenced sets (from references.ts
 * collectReferenced* run on the live scene), so only assets the scene uses are hashed and stored.
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
