import { Node, Material, TextureManager, Logger } from 'cleo'
import { cryptoRandomId } from './ids'

// Node variable linking a node's mesh material to a shared material asset.
export const MATERIAL_ID_VAR = '__materialId'

// A merged, multi-material model links one asset PER SUBMESH, held as a JSON string list because the node
// variable system has no array type. MATERIAL_ID_VAR must keep mirroring entry [0].
export const MATERIAL_IDS_VAR = '__materialIds'

// A reusable, named material saved to the global material library, with a rendered preview thumbnail.
export type MaterialAsset = {
  id: string
  name: string
  material: any          // Material.serialize() output
  /** TextureManager ids this material references. The payloads live in the texture store (textureStore.ts). */
  textureIds?: string[]
  /** Legacy: textures embedded as base64 ([{ id, data, config }]). Still read; never written. */
  textures?: any[]
  thumbnail: string      // base64 PNG data URL (empty until first save)
}

/** The material asset id a node currently references, or undefined. */
export function getMaterialIdOf(node: Node | null | undefined): string | undefined {
  return node?.getVariable(MATERIAL_ID_VAR)
}

/**
 * The per-submesh material asset ids a node references, one per submesh.
 * Falls back to MATERIAL_ID_VAR, so an unmerged node reads as a one-entry list.
 */
export function getMaterialIdsOf(node: Node | null | undefined): (string | undefined)[] {
  const raw = node?.getVariable(MATERIAL_IDS_VAR)
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map((id: any) => (typeof id === 'string' ? id : undefined))
    } catch { /* corrupt link: fall through to the single id */ }
  }
  const single = getMaterialIdOf(node)
  return single ? [single] : []
}

// Sprites must stay absent from all three. A sprite's image comes from its tileset and its
// tint/opacity/blending are plain node fields; its internal Material may never be linked to an asset.
//
// A DECAL is the one other node type in them. It projects its material rather than wearing it, but the
// material is linked, saved, propagated and deleted exactly like a model's: one slot, `decal.material`,
// with the same `__materialId` link. Every test here is by `nodeType` rather than `instanceof DecalNode`,
// for the reason the model checks already were: this module runs against a mocked `cleo` in tests, and an
// `instanceof` against a class the mock does not export throws.

/** The one shading model a decal can project. `DecalNode` refuses anything else and projects white. */
const DECAL_MATERIAL_TYPE = 'pbr'

/**
 * Whether a SERIALIZED material (an asset's `material`, a node payload's) is one a decal can project.
 * Mirrors `DecalNode`'s own rule, which parses and then tests `type === 'pbr'`: a Basic, Blinn-Phong, Cel or
 * custom material serializes under its own type and is refused.
 */
export function isProjectableMaterial(serialized: any): boolean {
  return !!serialized && typeof serialized === 'object' && serialized.type === DECAL_MATERIAL_TYPE
}

/**
 * Whether `asset` may be linked to `node`. Always true, except for a decal and a material that is not PBR:
 * the decal would store null and project plain white, which reads as the link having silently failed.
 */
export function canLinkMaterial(node: Node, asset: Pick<MaterialAsset, 'material'>): boolean {
  return node.nodeType !== 'decal' || isProjectableMaterial(asset.material)
}

/**
 * The material a freshly added decal starts with, and the one it falls back to when its link is removed.
 * A mid grey at partial coverage: visible on light and dark ground alike, and plainly a placeholder rather
 * than an authored look. PBR, or the decal would refuse it.
 */
export function defaultDecalMaterial(): Material {
  return Material.PBR({ baseColor: [0.5, 0.5, 0.5], roughness: 0.9, opacity: 0.8 })
}

/**
 * Give a decal with NO material the default one, so there is something to build an asset from. A decal
 * parsed from a payload whose material was not PBR comes back with null, and `createMaterialForNode` does
 * nothing at all for a node whose material is null. A no-op for everything else.
 */
export function seedDecalMaterial(node: Node): void {
  if (node.nodeType === 'decal' && !getNodeMaterial(node)) setNodeMaterial(node, defaultDecalMaterial())
}

/** The live Material carried by a node's mesh (or projected by a decal), or null for non-material nodes. */
export function getNodeMaterial(node: Node): Material | null {
  const n = node as any
  if (node.nodeType === 'model') return n.model?.material ?? null
  if (node.nodeType === 'decal') return n.material ?? null
  return null
}

/** True if this node type carries an editable material. */
export function nodeSupportsMaterial(node: Node | null | undefined): boolean {
  return !!node && (node.nodeType === 'model' || node.nodeType === 'decal')
}

/** Replace the live Material on a node's mesh. No-op for non-material nodes. */
function setNodeMaterial(node: Node, material: Material, submesh = 0): void {
  const n = node as any
  // A decal has exactly one slot. Callers have already refused a non-PBR material (see canLinkMaterial);
  // the setter would otherwise store null and warn.
  if (node.nodeType === 'decal') {
    if (submesh === 0) n.material = material
    return
  }
  if (node.nodeType !== 'model' || !n.model) return
  // `material` is the alias for materials[0], so the default case is unchanged.
  if (submesh === 0) n.model.material = material
  else if (submesh < n.model.materials.length) n.model.materials[submesh] = material
}

// Collect the texture ids referenced by a serialized material's flat `textures` map.
function collectMaterialTextureIds(serialized: any): Set<string> {
  const set = new Set<string>()
  const textures = serialized?.textures
  if (textures && typeof textures === 'object') {
    for (const v of Object.values(textures)) if (typeof v === 'string' && v) set.add(v)
  }
  return set
}

/**
 * Snapshot a live Material into a saveable asset.
 * Records only the texture IDS it uses; the payloads live once in the texture store.
 */
export function buildMaterialAsset(material: Material, name: string, thumbnail: string, id?: string): MaterialAsset {
  const serialized = material.serialize()
  const textureIds = [...collectMaterialTextureIds(serialized)]
  return { id: id ?? cryptoRandomId(), name, material: serialized, textureIds, thumbnail }
}

/** Every texture id a material asset references, whichever format it was saved in. */
export function materialAssetTextureIds(asset: MaterialAsset): string[] {
  if (asset.textureIds?.length) return asset.textureIds
  return (asset.textures ?? []).map((t: any) => t?.id).filter(Boolean)
}

/**
 * Apply a material asset to a node's `submesh`-th material: rebuild the Material and tag the link.
 *
 * Returns false, changing nothing, when the node cannot take it (a decal and a non-PBR asset — see
 * {@link canLinkMaterial}). User-facing link paths test `canLinkMaterial` first and say why; this is the
 * backstop for the ones that cannot, such as a linked asset re-saved as another shading model, where the
 * decal keeps its last good material and link rather than silently projecting white.
 */
export function applyMaterialAsset(node: Node, asset: MaterialAsset, submesh = 0): boolean {
  if (!canLinkMaterial(node, asset)) {
    Logger.warn(`'${node.name}' is a decal and can only project PBR materials; '${asset.name}' is ${asset.material?.type ?? 'unknown'}.`, 'Editor')
    return false
  }
  // Only legacy assets carry embedded base64; a current asset's textures are preloaded at boot.
  for (const t of asset.textures || []) {
    if (t?.id && !TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
  }
  setNodeMaterial(node, Material.parse(asset.material), submesh)
  if (submesh === 0) node.setVariable(MATERIAL_ID_VAR, asset.id, 'string')

  // Keep the per-submesh list in step whenever the node has one; the two links must never disagree.
  const ids = getMaterialIdsOf(node)
  if (ids.length > 1 || submesh > 0) {
    while (ids.length <= submesh) ids.push(undefined)
    ids[submesh] = asset.id
    node.setVariable(MATERIAL_IDS_VAR, JSON.stringify(ids), 'string')
  }
  return true
}

/**
 * Apply one material asset per submesh, in order, and stamp the whole link list in one go.
 * `assets` is parallel to the model's SUBMESHES, so a hole means "keep what the merge gave it". Holes must
 * be preserved in the stamped list, never compacted, or every later entry shifts onto the wrong range.
 */
export function applyMaterialAssets(node: Node, assets: (MaterialAsset | undefined)[]): void {
  assets.forEach((asset, i) => { if (asset) applyMaterialAsset(node, asset, i) })
  // `JSON.stringify` writes a hole as `null`, which getMaterialIdsOf reads back as undefined.
  if (assets.length > 1) node.setVariable(MATERIAL_IDS_VAR, JSON.stringify(assets.map(a => a?.id ?? null)), 'string')
}

/** The Basic + Null-texture material that referencing nodes fall back to when their asset is deleted. */
export function fallbackMaterial(): Material {
  return Material.Basic({ color: [1, 1, 1], opacity: 1, texture: 'Null' })
}

/**
 * What `node` falls back to when its link goes. The Basic fallback for everything but a decal, which would
 * refuse it and project plain white; a decal gets its placeholder instead.
 */
function fallbackMaterialFor(node: Node): Material {
  return node.nodeType === 'decal' ? defaultDecalMaterial() : fallbackMaterial()
}

/** Reset a node to the fallback material and drop its material-asset link (every submesh's). */
export function unlinkToFallback(node: Node): void {
  const n = node as any
  const count = n.model?.materials?.length ?? 1
  for (let i = 0; i < count; i++) setNodeMaterial(node, fallbackMaterialFor(node), i)
  node.removeVariable(MATERIAL_ID_VAR)
  node.removeVariable(MATERIAL_IDS_VAR)
}

/**
 * Which submeshes of `node` reference a given material asset — the one definition of "does this node use
 * that material", which every propagation and cleanup path must go through rather than the scalar
 * `__materialId`. Returns every matching slot; the same asset may be linked to several.
 */
export function materialSlotsReferencing(node: Node | null | undefined, materialId: string): number[] {
  const out: number[] = []
  const ids = getMaterialIdsOf(node)
  for (let i = 0; i < ids.length; i++) if (ids[i] === materialId) out.push(i)
  return out
}

/**
 * Reset ONE submesh to the fallback material and drop just that submesh's link.
 * `__materialId` keeps mirroring entry [0] and disappears with it, since callers not converted to the
 * per-submesh list still read the scalar.
 */
export function unlinkMaterialAt(node: Node, submesh: number): void {
  const n = node as any
  const count: number = n.model?.materials?.length ?? 1
  if (count <= 1) { unlinkToFallback(node); return }   // nothing to keep: the single-slot case is unchanged

  setNodeMaterial(node, fallbackMaterialFor(node), submesh)

  const ids = getMaterialIdsOf(node)
  while (ids.length < count) ids.push(undefined)
  ids[submesh] = undefined

  if (ids.every(id => !id)) {
    node.removeVariable(MATERIAL_ID_VAR)
    node.removeVariable(MATERIAL_IDS_VAR)
    return
  }
  node.setVariable(MATERIAL_IDS_VAR, JSON.stringify(ids), 'string')
  if (submesh === 0) node.removeVariable(MATERIAL_ID_VAR)
}

/** Read a node variable's value out of SERIALIZED json (the `{ type, value, access }` shape, or a bare value). */
export function serializedVar(json: any, name: string): string | undefined {
  const v = json?.variables?.[name]
  if (v && typeof v === 'object') return v.value
  return typeof v === 'string' ? v : undefined
}

/**
 * Re-resolve the embedded material copies in a SERIALIZED node subtree against the current library, in
 * place, before it is parsed into a scene. This is what makes `__materialId` the reference and the
 * embedded copy a fallback: templates and model assets bake their materials in, and resolving at
 * instantiation avoids rewriting every stored record (and churning its content hash) on each material save.
 * A node with no link, or one whose asset is gone, keeps whatever was embedded.
 */
export function resolveMaterialRefs(json: any, materials: MaterialAsset[]): void {
  if (!json || typeof json !== 'object') return
  // Deep-copy every resolved material: the asset's serialized material is shared library state.
  const resolve = (id: string | undefined) => {
    const asset = id ? materials.find(m => m.id === id) : undefined
    return asset ? JSON.parse(JSON.stringify(asset.material)) : undefined
  }

  const single = resolve(serializedVar(json, MATERIAL_ID_VAR))
  if (single && json.model) {
    json.model.material = single
    // `Model.parse` PREFERS `materials` over `material` whenever the array is present, so the singular
    // alone is not enough. Slot 0 and the scalar link are the same thing and must be written together.
    if (Array.isArray(json.model.materials) && json.model.materials.length) json.model.materials[0] = single
  }
  // A decal's one slot is `decal.material`, linked by the same scalar. An asset that has since become a
  // non-PBR material is not written: the decal would parse it to null and project white, so the embedded
  // copy — the last PBR material it was given — stands, exactly as `applyMaterialAsset` leaves a live one.
  if (single && json.decal && typeof json.decal === 'object' && isProjectableMaterial(single)) {
    json.decal.material = single
  }

  // A merged model links one asset per submesh; `materials` on the serialized model is parallel to them.
  const rawList = serializedVar(json, MATERIAL_IDS_VAR)
  if (rawList && json.model?.materials) {
    try {
      const ids = JSON.parse(rawList)
      if (Array.isArray(ids)) {
        ids.forEach((id: any, i: number) => {
          const resolved = resolve(typeof id === 'string' ? id : undefined)
          if (resolved && i < json.model.materials.length) json.model.materials[i] = resolved
        })
        // materials[0] and the single link are the same thing; keep them from drifting apart.
        if (json.model.materials.length) json.model.material = json.model.materials[0]
      }
    } catch { /* corrupt link: the embedded copies stand */ }
  }

  for (const child of json.children ?? []) resolveMaterialRefs(child, materials)
}
