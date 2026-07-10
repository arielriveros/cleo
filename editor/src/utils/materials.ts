import { Node, Material, TextureManager } from 'cleo'
import { cryptoRandomId } from './UIModel'

// Node variable that links a node's mesh material to a shared material asset (mirrors TEMPLATE_ID_VAR).
export const MATERIAL_ID_VAR = '__materialId'

// A reusable, named material saved to the global material library, with a rendered preview thumbnail.
export type MaterialAsset = {
  id: string
  name: string
  material: any        // Material.serialize() output
  textures: any[]      // [{ id, data, config }] snapshots from TextureManager
  thumbnail: string    // base64 PNG data URL (empty until first save)
}

/** The material asset id a node currently references, or undefined. */
export function getMaterialIdOf(node: Node | null | undefined): string | undefined {
  return node?.getVariable(MATERIAL_ID_VAR)
}

/** The live Material carried by a node's mesh (model or sprite), or null for non-material nodes. */
export function getNodeMaterial(node: Node): Material | null {
  const n = node as any
  if (node.nodeType === 'model') return n.model?.material ?? null
  if (node.nodeType === 'sprite' || node.nodeType === 'animatedSprite') return n.sprite?.material ?? null
  return null
}

/** True if this node type carries an editable material (model or sprite). */
export function nodeSupportsMaterial(node: Node | null | undefined): boolean {
  return !!node && (node.nodeType === 'model' || node.nodeType === 'sprite' || node.nodeType === 'animatedSprite')
}

/** Replace the live Material on a node's mesh (model or sprite). No-op for non-material nodes. */
function setNodeMaterial(node: Node, material: Material): void {
  const n = node as any
  if (node.nodeType === 'model' && n.model) n.model.material = material
  else if ((node.nodeType === 'sprite' || node.nodeType === 'animatedSprite') && n.sprite) n.sprite.material = material
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

/** Snapshot a live Material into a saveable asset, embedding the textures it references. */
export function buildMaterialAsset(material: Material, name: string, thumbnail: string, id?: string): MaterialAsset {
  const serialized = material.serialize()
  const texIds = collectMaterialTextureIds(serialized)
  const allTextures: any[] = (TextureManager.Instance as any).serializeTextureData?.() ?? []
  const textures = allTextures.filter((t: any) => texIds.has(t.id))
  return { id: id ?? cryptoRandomId(), name, material: serialized, textures, thumbnail }
}

/** Apply a material asset to a node: restore its textures, rebuild the Material, and tag the link. */
export function applyMaterialAsset(node: Node, asset: MaterialAsset): void {
  // Restore any embedded textures not already registered (the built-in 'Null' texture always exists).
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
