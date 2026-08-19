import { Node, Material, TextureManager } from 'cleo'
import { cryptoRandomId } from './UIModel'

// Node variable that links a node's mesh material to a shared material asset (mirrors TEMPLATE_ID_VAR).
export const MATERIAL_ID_VAR = '__materialId'

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
function setNodeMaterial(node: Node, material: Material): void {
  const n = node as any
  if (node.nodeType === 'model' && n.model) n.model.material = material
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

/** Apply a material asset to a node: rebuild the Material and tag the link. */
export function applyMaterialAsset(node: Node, asset: MaterialAsset): void {
  // New assets carry no payloads — their textures are preloaded from the texture store at boot, so they
  // are already registered. This loop only still matters for legacy assets with embedded base64.
  for (const t of asset.textures || []) {
    if (t?.id && !TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
  }
  setNodeMaterial(node, Material.parse(asset.material))
  node.setVariable(MATERIAL_ID_VAR, asset.id, 'string')
}

/** The Basic + Null-texture material that referencing nodes fall back to when their asset is deleted. */
export function fallbackMaterial(): Material {
  return Material.Basic({ color: [1, 1, 1], opacity: 1, texture: 'Null' })
}

/** Reset a node to the fallback material and drop its material-asset link. */
export function unlinkToFallback(node: Node): void {
  setNodeMaterial(node, fallbackMaterial())
  node.removeVariable(MATERIAL_ID_VAR)
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
  const id = serializedVar(json, MATERIAL_ID_VAR)
  if (id) {
    const asset = materials.find(m => m.id === id)
    // Deep-copy: the asset's serialized material is shared library state, and Material.parse must not be
    // handed something a later edit could mutate under it.
    if (asset && json.model) json.model.material = JSON.parse(JSON.stringify(asset.material))
  }
  for (const child of json.children ?? []) resolveMaterialRefs(child, materials)
}
