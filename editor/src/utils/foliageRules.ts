import {
  Node, ModelNode, AnimatedModel, TerrainFoliageRule, Vec, disposeModelSubtree,
  DEFAULT_FOLIAGE_DENSITY, FOLIAGE_DENSITY_UNIT,
} from 'cleo'
import { ModelAsset, resolvedLods } from './models'
import { MaterialAsset, resolveMaterialRefs } from './materials'
import { parseByType, regenerateIds } from './nodeSubtree'
import { cryptoRandomId } from './ids'
import { deepClone } from './deepClone'

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
  const clone = deepClone(nodeJson)
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
  // The holder's ModelNodes are real: `new Model` allocates GPU buffers in its constructor, and this
  // subtree exists only to read baked vertices out of. Without this, every prototype resolve leaked a
  // mesh set per sub-mesh — the same leak the model-instance paths had.
  disposeModelSubtree(holder)
  return models
}

/**
 * A ModelNode's model with its world transform (== level-relative: the flatten holder sits at identity)
 * baked into positions, and the normal matrix into normals/tangents/bitangents.
 *
 * Emits FLAT TYPED ARRAYS, matching what `serializeGeometry` writes for every other model in the project.
 * It used to emit one `[x,y,z]` JS array per vertex per attribute — five array objects per vertex — which
 * for one tree with three sub-meshes across three LOD levels was ~1.05 MILLION array objects and ~60 MB
 * against ~16 MB flat. Baked nine times per rule, once per terrain material referencing the model, that
 * is what exhausted the editor on save. Nothing downstream needed the tuples: `Geometry`'s constructor
 * takes a `Float32Array` with no copy at all, and both packers convert to typed arrays as step one.
 */
function bakeModel(node: ModelNode): any {
  const g = node.model.geometry
  const world = node.worldTransform
  const normalMat = Vec.mat3.normalFromMat4(Vec.mat3.create(), world)

  const v = Vec.vec3.create()
  // Written straight into a pre-sized buffer — no push, no growth, no per-vertex object.
  const points = (arr: ArrayLike<number>) => {
    const out = new Float32Array(arr.length)
    for (let i = 0; i < arr.length; i += 3) {
      Vec.vec3.set(v, arr[i], arr[i + 1], arr[i + 2])
      Vec.vec3.transformMat4(v, v, world)
      out[i] = v[0]; out[i + 1] = v[1]; out[i + 2] = v[2]
    }
    return out
  }
  const directions = (arr: ArrayLike<number>) => {
    const out = new Float32Array(arr.length)
    for (let i = 0; i < arr.length; i += 3) {
      Vec.vec3.set(v, arr[i], arr[i + 1], arr[i + 2])
      if (normalMat) { Vec.vec3.transformMat3(v, v, normalMat); Vec.vec3.normalize(v, v) }
      out[i] = v[0]; out[i + 1] = v[1]; out[i + 2] = v[2]
    }
    return out
  }

  return {
    geometry: {
      positions: points(g.positions),
      normals: directions(g.normals),
      tangents: directions(g.tangents),
      bitangents: directions(g.bitangents),
      // uvs are not transformed at all, so this is a straight copy.
      texCoords: new Float32Array(g.uvs),
      indices: new Uint32Array(g.indices),
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
    // Authored on the RULE like the impostor, not derived from the asset, so a re-sync must carry it.
    // Leaving it out silently cleared the inspector's own checkbox every time the button was pressed.
    castShadows: existing?.castShadows,
    // `existing` is already migrated, so its density passes through untouched, but the unit marker must
    // still be stamped or the returned rule is re-divided on its next load.
    density: existing?.density ?? DEFAULT_FOLIAGE_DENSITY.mesh,
    densityUnit: FOLIAGE_DENSITY_UNIT,
    minScale: existing?.minScale ?? 0.8,
    maxScale: existing?.maxScale ?? 1.4,
    collision: existing?.collision ?? null,
  }
}

// ---------------------------------------------------------------------------------------------------
// Resolving a rule's geometry from the model library
// ---------------------------------------------------------------------------------------------------

/** How {@link resolveFoliageRuleGeometry} reaches the libraries. Registered once by the editor. */
export type FoliageSourceResolver =
  (modelId: string) => { model: ModelAsset; library: ModelAsset[]; materials: MaterialAsset[] } | null

let sourceResolver: FoliageSourceResolver | null = null

/**
 * Give the foliage layer a way to look a model asset up by id.
 *
 * A module-level registration rather than a parameter threaded through
 * `parseTerrainMaterialAsset`/`applyTerrainMaterialToLayer` and their seven call sites — the same shape
 * `setGameHost` and `registerTemplates` already use for a cross-cutting dependency.
 */
export function registerFoliageSourceResolver(fn: FoliageSourceResolver | null): void {
  sourceResolver = fn
}

/**
 * Fill in a rule's prototype geometry from the model library, in place.
 *
 * A saved rule carries only its `modelId` and its authoring fields — the baked meshes are a DERIVED
 * cache and are no longer persisted, because storing them put a full copy of every tree in every terrain
 * material and a second copy in every scene blob that used one. This is where that cache is rebuilt, on
 * the way from a stored asset to a live `TerrainMaterial`.
 *
 * A rule that still carries embedded `models` (anything saved before this, and the shipped example
 * projects) is left exactly as it is — that is the legacy read path, and it costs nothing to keep.
 */
export function resolveFoliageRuleGeometry(rule: any): any {
  if (!rule || rule.kind !== 'mesh') return rule
  if (rule.models?.length || rule.model) return rule // already carries its geometry
  const modelId = rule.modelId ?? rule.meshId
  if (!modelId || !sourceResolver) return rule

  const source = sourceResolver(modelId)
  if (!source) return rule // the model was deleted; the layer keeps whatever it already had

  try {
    const models = flattenLevel(source.model.nodeJson, source.materials)
    if (!models.length) return rule
    // The library, not undefined: a LOD level is a REFERENCE to another model asset, so resolvedLods
    // needs it to find them — without it every level silently resolves to nothing.
    const lods = resolvedLods(source.model, source.library)
      .map(l => ({ models: flattenLevel(l.nodeJson, source.materials), distance: l.distance }))
      .filter(l => l.models.length > 0)
    rule.models = models
    if (lods.length) rule.lods = lods
  } catch {
    // A skinned or empty source throws in flattenLevel; leave the rule geometry-less rather than
    // half-populated, and the layer simply keeps its previous prototypes.
  }
  return rule
}
