import {
  Node, ModelNode, AnimatedModel, TerrainFoliageRule, Vec,
  DEFAULT_FOLIAGE_DENSITY, FOLIAGE_DENSITY_UNIT,
} from 'cleo'
import { ModelAsset, resolvedLods } from './models'
import { MaterialAsset, resolveMaterialRefs } from './materials'
import { parseByType, regenerateIds } from './nodeSubtree'
import { cryptoRandomId } from './ids'

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
function flattenLevel(nodeJson: any, materials?: MaterialAsset[]): any[] {
  const holder = new Node('__foliage_flatten')
  const clone = JSON.parse(JSON.stringify(nodeJson))
  regenerateIds(clone, new Map())
  // Re-resolve `__materialId` against the CURRENT library before baking, exactly as openMeshTab and
  // instantiateModelAsset do. A model asset's embedded material is a fallback, not the source of truth,
  // and baking it verbatim is what left foliage showing an old material until the model happened to be
  // re-opened and re-saved. Resolving here covers every LOD level, since each one flattens through this.
  if (materials) resolveMaterialRefs(clone, materials)
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
 * Build (or refresh) a terrain-material foliage rule from a model library asset: LOD0 plus every extra LOD
 * level flattened, the asset's cull distance, and `modelId` as the sync key. Scatter params and the
 * billboard impostor are authored on the RULE, so an existing rule's values are preserved on refresh.
 * `kind: 'mesh'` below is the rule's RENDERING MODE (real geometry vs a camera-facing 'billboard'), not an
 * asset type.
 */
export function buildFoliageRuleFromModelAsset(asset: ModelAsset, existing?: TerrainFoliageRule,
                                              library?: ModelAsset[], materials?: MaterialAsset[]): TerrainFoliageRule {
  const models = flattenLevel(asset.nodeJson, materials)
  if (models.length === 0) throw new Error(`Model "${asset.name}" has no static geometry`)
  // LOD levels are references into the model library, so the rule flattens the referenced asset's subtree.
  // A level whose model is gone is dropped by resolvedLods before this point.
  const lods = resolvedLods(asset, library)
    .map(l => ({ models: flattenLevel(l.nodeJson, materials), distance: l.distance }))
    .filter(l => l.models.length > 0)

  return {
    kind: 'mesh',
    // PRESERVED, never regenerated: this is what a live foliage layer is filed under, so minting a new
    // one on every re-derive would orphan the layer this rebuild exists to keep up to date.
    id: existing?.id ?? cryptoRandomId(),
    name: existing?.name ?? asset.name,
    modelId: asset.id,
    models,
    lods: lods.length ? lods : undefined,
    cullDistance: asset.cullDistance ?? 0,
    billboard: existing?.billboard ?? null,
    // `existing` is already migrated, so its density passes through untouched, but the unit marker must
    // still be stamped or the returned rule is re-divided on its next load.
    density: existing?.density ?? DEFAULT_FOLIAGE_DENSITY.mesh,
    densityUnit: FOLIAGE_DENSITY_UNIT,
    minScale: existing?.minScale ?? 0.8,
    maxScale: existing?.maxScale ?? 1.4,
    collision: existing?.collision ?? null,
  }
}
