import { Node, ModelNode, AnimatedModel, TerrainFoliageRule, Vec } from 'cleo'
import { ModelAsset, resolvedLods } from './models'
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
        throw new Error(`"${node.name}" is skinned — foliage models must be static`)
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
  // Geometry stores attributes flat (stride 3, or 2 for uvs); the foliage rule format is nested, so
  // these walk the flat buffer and emit tuples.
  const points = (arr: ArrayLike<number>) => {
    const out: number[][] = []
    for (let i = 0; i < arr.length; i += 3) {
      Vec.vec3.set(v, arr[i], arr[i + 1], arr[i + 2])
      Vec.vec3.transformMat4(v, v, world)
      out.push([v[0], v[1], v[2]])
    }
    return out
  }
  const directions = (arr: ArrayLike<number>) => {
    const out: number[][] = []
    for (let i = 0; i < arr.length; i += 3) {
      Vec.vec3.set(v, arr[i], arr[i + 1], arr[i + 2])
      if (normalMat) { Vec.vec3.transformMat3(v, v, normalMat); Vec.vec3.normalize(v, v) }
      out.push([v[0], v[1], v[2]])
    }
    return out
  }
  const pairs = (arr: ArrayLike<number>) => {
    const out: number[][] = []
    for (let i = 0; i < arr.length; i += 2) out.push([arr[i], arr[i + 1]])
    return out
  }

  return {
    geometry: {
      positions: points(g.positions),
      normals: directions(g.normals),
      tangents: directions(g.tangents),
      bitangents: directions(g.bitangents),
      texCoords: pairs(g.uvs),
      indices: [...g.indices],
    },
    material: node.model.material.serialize(),
  }
}

/**
 * Build (or refresh) a terrain-material foliage rule from a model library asset: LOD0 + every extra LOD
 * level flattened, the asset's cull distance, and `modelId` as the sync key so saving the model asset
 * updates the rule. Scatter params and the billboard impostor are authored on the RULE, so an existing
 * rule's values are preserved on refresh.
 *
 * `kind: 'mesh'` below is NOT the old asset-type name — it is the rule's rendering mode (real geometry,
 * as opposed to a camera-facing 'billboard' impostor) and is deliberately left alone.
 */
export function buildFoliageRuleFromModelAsset(asset: ModelAsset, existing?: TerrainFoliageRule, library?: ModelAsset[]): TerrainFoliageRule {
  const models = flattenLevel(asset.nodeJson)
  if (models.length === 0) throw new Error(`Model "${asset.name}" has no static geometry`)
  // LOD levels are references into the model library, so the rule flattens the referenced asset's subtree.
  // Levels whose model is gone resolve to null and are dropped by resolvedLods before we get here.
  const lods = resolvedLods(asset, library)
    .map(l => ({ models: flattenLevel(l.nodeJson), distance: l.distance }))
    .filter(l => l.models.length > 0)

  return {
    kind: 'mesh',
    name: existing?.name ?? asset.name,
    modelId: asset.id,
    models,
    lods: lods.length ? lods : undefined,
    cullDistance: asset.cullDistance ?? 0,
    billboard: existing?.billboard ?? null,
    density: existing?.density ?? 4,
    minScale: existing?.minScale ?? 0.8,
    maxScale: existing?.maxScale ?? 1.4,
  }
}
