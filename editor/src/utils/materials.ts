import { Node, Material, TextureManager } from 'cleo'
import { cryptoRandomId } from './ids'

// Node variable that links a node's mesh material to a shared material asset (mirrors TEMPLATE_ID_VAR).
export const MATERIAL_ID_VAR = '__materialId'

// A merged, multi-material model links one asset PER SUBMESH. Held as a JSON string list, the same
// convention SCREEN_MATERIAL_IDS_VAR uses, because the node variable system has no array type.
// MATERIAL_ID_VAR keeps mirroring entry [0] so everything that reads a node's single material still works.
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
 *
 * Falls back to the single MATERIAL_ID_VAR so an unmerged node reads as a one-entry list and callers
 * need only one code path.
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

// Sprites are deliberately absent from all three of these. A sprite's image comes from its tileset and
// its tint/opacity/blending are plain fields on the node; the Material it still holds internally is an
// implementation detail of the renderer, not something a material asset may be linked to.

/** The live Material carried by a node's mesh, or null for non-material nodes. */
export function getNodeMaterial(node: Node): Material | null {
  const n = node as any
  if (node.nodeType === 'model') return n.model?.material ?? null
  return null
}

/** True if this node type carries an editable material. */
export function nodeSupportsMaterial(node: Node | null | undefined): boolean {
  return !!node && node.nodeType === 'model'
}

/** Replace the live Material on a node's mesh. No-op for non-material nodes. */
function setNodeMaterial(node: Node, material: Material, submesh = 0): void {
  const n = node as any
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
 *
 * The asset records only the texture IDS it uses — the payloads live once in the texture store, not
 * embedded per asset. This used to serialize every texture in the project to base64 and then filter, once
 * per material, which is what froze the editor on import.
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

/** Apply a material asset to a node's `submesh`-th material: rebuild the Material and tag the link. */
export function applyMaterialAsset(node: Node, asset: MaterialAsset, submesh = 0): void {
  // New assets carry no payloads — their textures are preloaded from the texture store at boot, so they
  // are already registered. This loop only still matters for legacy assets with embedded base64.
  for (const t of asset.textures || []) {
    if (t?.id && !TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
  }
  setNodeMaterial(node, Material.parse(asset.material), submesh)
  if (submesh === 0) node.setVariable(MATERIAL_ID_VAR, asset.id, 'string')

  // Keep the per-submesh list in step whenever the node has one, so the two links can never disagree.
  const ids = getMaterialIdsOf(node)
  if (ids.length > 1 || submesh > 0) {
    while (ids.length <= submesh) ids.push(undefined)
    ids[submesh] = asset.id
    node.setVariable(MATERIAL_IDS_VAR, JSON.stringify(ids), 'string')
  }
}

/**
 * Apply one material asset per submesh, in order, and stamp the whole link list in one go.
 *
 * `assets` is parallel to the model's SUBMESHES, so a hole is meaningful: that submesh keeps the material
 * the merge gave it and records no link. Holes must be preserved in the stamped list rather than
 * compacted away, or every later entry shifts onto the wrong range.
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

/** Reset a node to the fallback material and drop its material-asset link (every submesh's). */
export function unlinkToFallback(node: Node): void {
  const n = node as any
  const count = n.model?.materials?.length ?? 1
  for (let i = 0; i < count; i++) setNodeMaterial(node, fallbackMaterial(), i)
  node.removeVariable(MATERIAL_ID_VAR)
  node.removeVariable(MATERIAL_IDS_VAR)
}

/**
 * Which submeshes of `node` reference a given material asset.
 *
 * The one definition of "does this node use that material", so every propagation and cleanup path agrees.
 * Matching on `getMaterialIdOf` instead — the scalar `__materialId`, which only ever mirrors entry [0] —
 * is what made an edit to a second submesh's material match no node at all and silently do nothing.
 *
 * Returns every matching slot, since the same asset may legitimately be linked to several.
 */
export function materialSlotsReferencing(node: Node | null | undefined, materialId: string): number[] {
  const out: number[] = []
  const ids = getMaterialIdsOf(node)
  for (let i = 0; i < ids.length; i++) if (ids[i] === materialId) out.push(i)
  return out
}

/**
 * Reset ONE submesh to the fallback material and drop just that submesh's link.
 *
 * The ✕ on a material slot used to call {@link unlinkToFallback}, which resets every submesh and removes
 * both link variables — so clearing one slot of a merged model wiped all of them. `setNodeMaterial`
 * already writes a single index, so nothing ever required the whole-node behaviour.
 *
 * `__materialId` keeps mirroring entry [0] (and disappears with it), because everything that has not been
 * converted to the per-submesh list still reads the scalar.
 */
export function unlinkMaterialAt(node: Node, submesh: number): void {
  const n = node as any
  const count: number = n.model?.materials?.length ?? 1
  if (count <= 1) { unlinkToFallback(node); return }   // nothing to keep: the single-slot case is unchanged

  setNodeMaterial(node, fallbackMaterial(), submesh)

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
 * place, before it is parsed into a scene.
 *
 * This is what makes __materialId the reference and the embedded copy a mere fallback. Templates and mesh
 * assets each store a whole serialized subtree with its materials baked in, so a material edited after the
 * template was saved leaves that copy stale. Rather than rewriting every stored template/mesh record on
 * each material save — which would churn their content hashes and make resyncScene needlessly
 * re-instantiate every placed instance, besides rewriting megabytes of embedded geometry — we resolve the
 * link at the moment of instantiation, which is the only moment the copy is actually read.
 *
 * A node with no link, or one whose asset is gone, keeps whatever was embedded.
 */
export function resolveMaterialRefs(json: any, materials: MaterialAsset[]): void {
  if (!json || typeof json !== 'object') return
  // Deep-copy every resolved material: the asset's serialized material is shared library state, and
  // Material.parse must not be handed something a later edit could mutate under it.
  const resolve = (id: string | undefined) => {
    const asset = id ? materials.find(m => m.id === id) : undefined
    return asset ? JSON.parse(JSON.stringify(asset.material)) : undefined
  }

  const single = resolve(serializedVar(json, MATERIAL_ID_VAR))
  if (single && json.model) {
    json.model.material = single
    // `Model.parse` PREFERS `materials` over `material` whenever the array is present, so writing only the
    // singular here left a merged model rendering the stale embedded copy while its resolved link sat in a
    // field nothing read. Slot 0 and the scalar link are the same thing; keep them together from the start.
    if (Array.isArray(json.model.materials) && json.model.materials.length) json.model.materials[0] = single
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
