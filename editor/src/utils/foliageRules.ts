import { Node, ModelNode, AnimatedModel, TerrainFoliageRule, Vec } from 'cleo'
import { MeshAsset } from './meshes'
import { parseByType, regenerateIds } from './nodeSubtree'

// Builds engine-consumable foliage rules from mesh library assets. A TerrainFoliageRule must stay plain
// JSON (material.ts cannot import scene/foliage classes), so a mesh asset's subtree is flattened here:
// one Model.serialize() payload per sub-mesh with its level-relative transform BAKED into the geometry
// (foliage instancing has a single mat4 per instance — there is no room for per-sub-mesh transforms).

/**
 * Flatten one LOD level's serialized subtree into a list of Model JSON payloads. The subtree is
 * re-instantiated through the engine's own parser (so transforms/eulers are interpreted exactly as the
 * renderer would), then each ModelNode's world transform — relative to the level root — is baked into a
 * cloned geometry. Skinned models are rejected: their vertices are bound to a skeleton.
 */
function flattenLevel(nodeJson: any): any[] {
  const holder = new Node('__foliage_flatten')
  const clone = JSON.parse(JSON.stringify(nodeJson))
  regenerateIds(clone, new Map())
  parseByType(holder, clone)
  holder.updateTransforms()

  const models: any[] = []
  const visit = (node: Node) => {
    if (node instanceof ModelNode) {
      if (node.model instanceof AnimatedModel)
        throw new Error(`"${node.name}" is skinned — foliage meshes must be static`)
      models.push(bakeModel(node))
    }
    for (const child of node.children) visit(child)
  }
  visit(holder)
  return models
}

/** Serialize a ModelNode's model with its world transform (== level-relative: the flatten holder sits
 *  at identity) baked into positions, and the normal matrix into normals/tangents/bitangents. */
function bakeModel(node: ModelNode): any {
  const g = node.model.geometry
  const world = node.worldTransform
  const normalMat = Vec.mat3.normalFromMat4(Vec.mat3.create(), world)

  const v = Vec.vec3.create()
  const points = (arr: ArrayLike<number>[]) => Array.from(arr).map(p => {
    Vec.vec3.set(v, p[0], p[1], p[2])
    Vec.vec3.transformMat4(v, v, world)
    return [v[0], v[1], v[2]]
  })
  const directions = (arr: ArrayLike<number>[]) => Array.from(arr).map(p => {
    Vec.vec3.set(v, p[0], p[1], p[2])
    if (normalMat) { Vec.vec3.transformMat3(v, v, normalMat); Vec.vec3.normalize(v, v) }
    return [v[0], v[1], v[2]]
  })

  return {
    geometry: {
      positions: points(g.positions),
      normals: directions(g.normals),
      tangents: directions(g.tangents),
      bitangents: directions(g.bitangents),
      texCoords: Array.from(g.uvs).map(uv => [uv[0], uv[1]]),
      indices: [...g.indices],
    },
    material: node.model.material.serialize(),
  }
}

/**
 * Build (or refresh) a terrain-material foliage rule from a mesh library asset: LOD0 + every extra LOD
 * level flattened, the asset's cull distance, and `meshId` as the sync key so saving the mesh asset
 * updates the rule. Scatter params and the billboard impostor are authored on the RULE, so an existing
 * rule's values are preserved on refresh.
 */
export function buildFoliageRuleFromMeshAsset(asset: MeshAsset, existing?: TerrainFoliageRule): TerrainFoliageRule {
  const models = flattenLevel(asset.nodeJson)
  if (models.length === 0) throw new Error(`Mesh "${asset.name}" has no static sub-meshes`)
  const lods = (asset.lods ?? [])
    .map(l => ({ models: flattenLevel(l.nodeJson), distance: l.distance }))
    .filter(l => l.models.length > 0)

  return {
    kind: 'mesh',
    name: existing?.name ?? asset.name,
    meshId: asset.id,
    models,
    lods: lods.length ? lods : undefined,
    cullDistance: asset.cullDistance ?? 0,
    billboard: existing?.billboard ?? null,
    density: existing?.density ?? 4,
    minScale: existing?.minScale ?? 0.8,
    maxScale: existing?.maxScale ?? 1.4,
  }
}
