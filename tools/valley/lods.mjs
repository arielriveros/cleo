// LOD levels and distance culling for the Valley's static model assets (buildings, dungeon props).
//
// A generated level is what the editor's "Generate LOD levels…" writes (applications/editor/src/utils/
// lodGenerate.ts): the asset's level-0 subtree with every model's geometry decimated and nothing else
// changed — same names, same transforms, same scripts — embedded in the asset as
// `{ generated: true, distance, nodeJson }`. Its parts link the library material as LEVEL links
// (`__lodMaterialId` + `__lodLevel`), never `__materialId`, so the editor derives each level's material
// from the current library one.
//
// A placed copy of an asset with levels or a cull distance is the wrapper `instantiateModelAsset` builds
// (applications/editor/src/utils/models.ts): an identity-rooted `lodGroup` named after the asset, the
// level-0 subtree as child 0, the levels after it, `__modelId` on the wrapper. The generator has to emit
// that shape itself: the shipped scenes store the models' hashes, so the editor never rebuilds them.

import { decimate } from './meshes.mjs'

/** A part below this many triangles is carried into every level unchanged: QEM on a 12-triangle plank tears it. */
const MIN_TRIANGLES = 200

const roundTo = (arr, digits) => {
  const f = 10 ** digits
  return Array.from(arr, v => Math.round(v * f) / f)
}

function walk(json, visit) {
  visit(json)
  for (const child of json.children ?? []) walk(child, visit)
}

function modelTriangles(json) {
  let n = 0
  walk(json, j => { if (j.type === 'model' && j.model?.geometry) n += j.model.geometry.indices.length / 3 })
  return n
}

/** One level: a deep copy of `base` with each model's geometry decimated to `ratio` and level links. */
function levelOf(root, base, ratio, level, idOf) {
  const json = structuredClone(base)
  let k = 0
  let reduced = false
  walk(json, (j) => {
    j.id = idOf(`lod${level}:${k++}`)
    if (j.type !== 'model' || !j.model?.geometry) return
    const g = j.model.geometry
    if (g.indices.length / 3 >= MIN_TRIANGLES) {
      const out = decimate(root, {
        positions: Float32Array.from(g.positions), normals: Float32Array.from(g.normals),
        uvs: Float32Array.from(g.texCoords), indices: Uint32Array.from(g.indices),
      }, ratio)
      j.model = {
        ...j.model,
        geometry: {
          ...g,
          positions: roundTo(out.positions, 3), normals: roundTo(out.normals, 3),
          texCoords: roundTo(out.uvs, 4), indices: Array.from(out.indices),
        },
      }
      reduced = true
    }
    const link = j.variables?.__materialId
    if (link) {
      const { __materialId, ...rest } = j.variables
      j.variables = {
        ...rest,
        __lodMaterialId: { ...link },
        __lodLevel: { type: 'string', value: String(level), access: link.access ?? 'public' },
      }
    }
  })
  return reduced ? json : null
}

/**
 * Give `asset` generated LOD levels and a cull distance, in place. `levels` is `[{ ratio, distance }]`,
 * ascending; a level that would reduce nothing (every part already tiny) is dropped with its distance,
 * which leaves a small hand-built prop with only its cull distance. Returns the triangle count per level.
 */
export function addLods(root, asset, { levels = [], cullDistance = 0 }, idOf) {
  const lods = []
  for (const [i, { ratio, distance }] of levels.entries()) {
    const nodeJson = levelOf(root, asset.nodeJson, ratio, i + 1, (key) => idOf(`${asset.id}:${key}`))
    if (nodeJson) lods.push({ generated: true, distance, nodeJson })
  }
  if (lods.length) asset.lods = lods
  if (cullDistance > 0) asset.cullDistance = cullDistance
  return [asset.nodeJson, ...lods.map(l => l.nodeJson)].map(modelTriangles)
}

/** Whether a placed copy of `asset` is LOD-wrapped (models.ts `modelAssetHasLodBehavior`). */
export const hasLodBehavior = (asset) => !!asset.lods?.length || (asset.cullDistance ?? 0) > 0

/**
 * A fresh copy of `asset` to place, ids not yet re-keyed: the bare subtree, or the lodGroup wrapper
 * around level 0 and its levels. The caller re-keys, then sets the transform, variables and body on the
 * returned root — on the wrapper the levels keep the asset root's own (identity) transform under it.
 */
export function placeableCopy(asset) {
  if (!hasLodBehavior(asset)) return structuredClone(asset.nodeJson)
  const lods = asset.lods ?? []
  return {
    id: '', name: asset.name, type: 'lodGroup',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    children: [structuredClone(asset.nodeJson), ...lods.map(l => structuredClone(l.nodeJson))],
    variables: {}, spawnOnStart: true,
    distances: [0, ...lods.map(l => l.distance)],
    cullDistance: asset.cullDistance ?? 0,
  }
}
