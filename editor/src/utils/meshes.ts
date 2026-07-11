import { Node, TextureManager } from 'cleo'
import { cryptoRandomId } from './UIModel'
import { parseByType, stripDebug, collectTextureIds, regenerateIds } from './nodeSubtree'

// Node variable linking a placed instance back to its source mesh asset (mirrors TEMPLATE_ID_VAR /
// MATERIAL_ID_VAR). Informational only — meshes are not edit-propagated — but handy for tooling.
export const MESH_ID_VAR = '__meshId'

// A reusable, named mesh imported from file(s): a serialized node subtree (the parent Node with its
// child ModelNodes) plus every texture it embeds and a rendered thumbnail. Materials are embedded in
// the subtree (self-contained) and additionally linked to Material library assets via __materialId.
export type MeshAsset = {
  id: string
  name: string
  nodeJson: any        // serialized parent Node subtree (child ModelNodes; materials embedded + __materialId)
  textures: any[]      // [{ id, data, config }] snapshots from TextureManager
  materialIds: string[]// MaterialAsset ids this mesh references (informational)
  thumbnail: string    // base64 PNG data URL
}

/** Snapshot a live node subtree into a saveable mesh asset, embedding the textures it references. */
export async function buildMeshAsset(root: Node, materialIds: string[], thumbnail: string, id?: string): Promise<MeshAsset> {
  const nodeJson = await root.serialize()
  stripDebug(nodeJson)
  // A definition must never carry an instance back-link; strip it so it isn't baked in.
  if (nodeJson.variables) delete nodeJson.variables[MESH_ID_VAR]

  const texIds = new Set<string>()
  collectTextureIds(nodeJson, texIds)
  const allTextures: any[] = (TextureManager.Instance as any).serializeTextureData?.() ?? []
  const textures = allTextures.filter((t: any) => texIds.has(t.id))

  return { id: id ?? cryptoRandomId(), name: root.name, nodeJson, textures, materialIds, thumbnail }
}

/** Instantiate a mesh asset under `parent`, regenerating ids and restoring embedded textures. Returns the new root id. */
export function instantiateMeshAsset(asset: MeshAsset, parent: Node): string {
  const clone = JSON.parse(JSON.stringify(asset.nodeJson))
  const idMap = new Map<string, string>()
  regenerateIds(clone, idMap)

  // Tag the instance root so it can be recognized as a placed mesh instance. Persists via the node's
  // serialized `variables`.
  clone.variables = { ...(clone.variables || {}), [MESH_ID_VAR]: { type: 'string', value: asset.id } }

  // Restore any embedded textures not already present.
  for (const t of asset.textures || []) {
    if (t?.id && !TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
  }

  parseByType(parent, clone)
  return clone.id
}
