import type { MaterialAsset } from './materials'
import type { MeshAsset } from './meshes'
import type { Template } from './templates'
import type { TerrainMaterialAsset } from './terrainMaterials'

// Content hashes let a closed scene decide, when it is next opened, whether each asset it references
// actually changed since the scene was saved — so unchanged meshes/templates aren't needlessly
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

/** Deep-stringify `obj` with any `thumbnail` field omitted at every level, then hash it. */
export function hashAsset(obj: any): string {
  const json = JSON.stringify(obj, (key, value) => (key === 'thumbnail' ? undefined : value))
  return fnv1a(json ?? '')
}

export interface AssetLibs {
  materials: MaterialAsset[]
  meshes: MeshAsset[]
  templates: Template[]
  terrainMaterials: TerrainMaterialAsset[]
}

/** The hash-map key for an asset of a given kind. Kept in one place so save and resync agree. */
export function assetHashKey(kind: 'material' | 'mesh' | 'template' | 'terrainMaterial', id: string): string {
  return `${kind}:${id}`
}

/**
 * Content hashes keyed "kind:id" for every asset id the just-referenced sets contain. Callers pass the
 * referenced-id sets (from references.ts collectReferenced* run on the live scene) so only assets the
 * scene actually uses are hashed and stored.
 */
export function buildAssetHashes(
  refs: { materialIds: Set<string>; meshIds: Set<string>; templateIds: Set<string>; terrainMaterialIds: Set<string> },
  libs: AssetLibs,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of libs.materials) if (refs.materialIds.has(m.id)) out[assetHashKey('material', m.id)] = hashAsset(m)
  for (const m of libs.meshes) if (refs.meshIds.has(m.id)) out[assetHashKey('mesh', m.id)] = hashAsset(m)
  for (const t of libs.templates) if (refs.templateIds.has(t.id)) out[assetHashKey('template', t.id)] = hashAsset(t)
  for (const t of libs.terrainMaterials) if (refs.terrainMaterialIds.has(t.id)) out[assetHashKey('terrainMaterial', t.id)] = hashAsset(t)
  return out
}
