import { Node, ModelNode, TextureManager } from 'cleo'
import { cryptoRandomId } from './UIModel'
import { parseByType, stripDebug, collectTextureIds, regenerateIds } from './nodeSubtree'

// Node variable linking a placed instance back to its source mesh asset (mirrors TEMPLATE_ID_VAR /
// MATERIAL_ID_VAR). Saving a mesh asset re-instantiates every scene node carrying it
// (syncMeshInstances in EngineContext), the same way template edits propagate.
export const MESH_ID_VAR = '__meshId'

/** One extra detail level of a mesh asset: a whole serialized subtree (levels come from separate
 *  files, so sub-mesh counts may differ) plus the camera distance at which it takes over. */
export type MeshLodDef = { nodeJson: any; distance: number }

// A reusable, named mesh imported from file(s): a serialized node subtree (the parent Node with its
// child ModelNodes) plus every texture it embeds and a rendered thumbnail. Materials are embedded in
// the subtree (self-contained) and additionally linked to Material library assets via __materialId.
export type MeshAsset = {
  id: string
  name: string
  nodeJson: any          // serialized parent Node subtree (child ModelNodes; materials embedded + __materialId)
  /** TextureManager ids this subtree references. The payloads live in the texture store (textureStore.ts). */
  textureIds?: string[]
  /** Legacy: textures embedded as base64 ([{ id, data, config }]). Still read; never written. */
  textures?: any[]
  materialIds: string[]  // MaterialAsset ids this mesh references (informational)
  thumbnail: string      // base64 PNG data URL
  /** Extra LOD levels (ascending distance). Absent/empty = single-level mesh. */
  lods?: MeshLodDef[]
  /** Hide placed instances beyond this camera distance; 0/absent = never cull. */
  cullDistance?: number
}

/**
 * Snapshot a live node subtree into a saveable mesh asset.
 *
 * Records only the texture IDS the subtree uses; the payloads live once in the texture store. Embedding
 * them here duplicated every map the mesh's materials had already embedded themselves.
 */
export async function buildMeshAsset(
  root: Node,
  materialIds: string[],
  thumbnail: string,
  id?: string,
  lods?: MeshLodDef[],
  cullDistance?: number,
): Promise<MeshAsset> {
  const nodeJson = await root.serialize()
  stripDebug(nodeJson)
  // A definition must never carry an instance back-link; strip it so it isn't baked in.
  if (nodeJson.variables) delete nodeJson.variables[MESH_ID_VAR]

  const texIds = new Set<string>()
  collectTextureIds(nodeJson, texIds)

  const asset: MeshAsset = { id: id ?? cryptoRandomId(), name: root.name, nodeJson, textureIds: [...texIds], materialIds, thumbnail }

  if (lods?.length) {
    for (const lod of lods) {
      stripDebug(lod.nodeJson)
      if (lod.nodeJson.variables) delete lod.nodeJson.variables[MESH_ID_VAR]
      collectTextureIds(lod.nodeJson, texIds)
    }
    asset.lods = lods
    asset.textureIds = [...texIds]
  }
  if (cullDistance && cullDistance > 0) asset.cullDistance = cullDistance

  return asset
}

/** True if a serialized subtree contains a skinned/animated model (LOD + foliage baking are static-only). */
export function nodeJsonHasSkinnedModel(nodeJson: any): boolean {
  if (!nodeJson || typeof nodeJson !== 'object') return false
  const m = nodeJson.model
  if (m && (m.skin || m.animations || m.jointIndices)) return true
  return Array.isArray(nodeJson.children) && nodeJson.children.some(nodeJsonHasSkinnedModel)
}

/** True if the asset carries LOD levels or a cull distance (i.e. it instantiates as a LodGroupNode). */
export function meshAssetHasLodBehavior(asset: MeshAsset): boolean {
  return !!asset.lods?.length || (asset.cullDistance ?? 0) > 0
}

/** Every texture id a mesh asset references, whichever format it was saved in. */
export function meshAssetTextureIds(asset: MeshAsset): string[] {
  if (asset.textureIds?.length) return asset.textureIds
  return (asset.textures ?? []).map((t: any) => t?.id).filter(Boolean)
}

/**
 * Turn one imported subtree into a separate MeshAsset per sub-mesh (the import modal's "Separate
 * sub-meshes" option). Each asset is re-centred on its own bounds, so dragging it into the scene drops it
 * where you point instead of wherever it happened to sit in the source file.
 *
 * The re-centring is done with the NODE TRANSFORM, never by translating vertices: a skinned mesh's
 * vertices are bound to its skeleton and moving them would break the binding (the same reason
 * normalizeRootScale falls back to transform-space scaling for skinned subtrees).
 *
 * Rotation and scale are deliberately KEPT — those are the sub-mesh's authored size and orientation. Only
 * its position (the file's layout) is dropped.
 */
export async function separateSubMeshes(
  root: Node,
  children: ModelNode[],
  bundleName: string,
  materialIdOfChild: Map<ModelNode, string>,
): Promise<MeshAsset[]> {
  const assets: MeshAsset[] = []
  const rootScale = root.scale

  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    const name = child.name?.trim() || `${bundleName}_${i + 1}`

    const holder = new Node(name)
    // normalizeRootScale scales a SKINNED subtree through the root's transform (it cannot bake into the
    // vertices), so a separated skinned child would silently lose its normalization without this.
    holder.setScale([rootScale[0], rootScale[1], rootScale[2]])

    child.setPosition([0, 0, 0]) // drop the file's authored layout; keep rotation + scale
    holder.addChild(child)
    holder.updateTransforms()

    // Shift the child so its bounds land on the origin. getBoundingSphere is WORLD space, and the holder
    // sits at the origin with only a scale, so dividing that scale back out converts it to the child's
    // local space.
    const center = child.getBoundingSphere().center
    const sx = rootScale[0] || 1, sy = rootScale[1] || 1, sz = rootScale[2] || 1
    child.setPosition([-center[0] / sx, -center[1] / sy, -center[2] / sz])
    holder.updateTransforms()

    const materialId = materialIdOfChild.get(child)
    assets.push(await buildMeshAsset(holder, materialId ? [materialId] : [], ''))
  }

  return assets
}

/** Instantiate a mesh asset under `parent`, regenerating ids and restoring embedded textures. Returns the new root id.
 *  Assets with LOD levels or a cull distance instantiate as a LodGroupNode wrapping one child subtree
 *  per level (level 0 = the base nodeJson); plain assets keep the original single-subtree shape. */
export function instantiateMeshAsset(asset: MeshAsset, parent: Node): string {
  const clone = meshAssetHasLodBehavior(asset)
    ? {
        id: cryptoRandomId(),
        name: asset.name,
        type: 'lodGroup',
        distances: [0, ...(asset.lods ?? []).map(l => l.distance)],
        cullDistance: asset.cullDistance ?? 0,
        children: [
          JSON.parse(JSON.stringify(asset.nodeJson)),
          ...(asset.lods ?? []).map(l => JSON.parse(JSON.stringify(l.nodeJson))),
        ],
      } as any
    : JSON.parse(JSON.stringify(asset.nodeJson))

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
