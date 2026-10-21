// The hamlet's buildings: four FBX props through assimp, as static parts per material.
//
// The exports disagree about their units. The house is centimetres (19 m across, 6 m tall — an old
// L-shaped farmhouse). The other three came out of one Blender scene with no unit stamp and read
// 25-50 m tall in centimetres, which no thatched hut is; each is therefore scaled to a stated real
// HEIGHT instead, and the height is the one number to change if a building looks wrong.
//
// The windmill ships its body and its sails as separate files (construction.fbx, wings.fbx), each
// centred on its own origin. Where the sails go was measured off the merged farm_windmill.fbx: the hub
// sits 1169 units in front of the body's -X face line and 2880 up, which is what HUB below records. The
// sails stay a separate node so ValleyWindmill.ts can turn them about that axle.

import path from 'path'
import { loadAssimp, toGltf } from '../exampleKit/fbxImport.mjs'
import { boundsOf, decimate, mergeByMaterial, normalizeParts, partsOf, triangles } from './meshes.mjs'

/** Windmill sail hub in construction.fbx's own units (see the header). */
const HUB = [-1169, 2880, 2]

/**
 * Each prop: its source file, its scale (fixed, or to a target height), and which surface each of the
 * file's materials gets. Surface keys name materials built by build.mjs.
 */
export const PROPS = [
  // 90k triangles of scan-like detail; QEM to a third reads the same from a few metres away.
  { key: 'house', name: 'Old House', file: 'house/003_fbx.fbx', scale: 0.01, decimate: 0.35, surfaces: { 0: 'house' } },
  // The artist's own LOD1: LOD0's thatch is 117k triangles of cards, LOD1's 7k of the same silhouette.
  { key: 'long-house', name: 'Long House', file: 'long_house/model/LOD1_long_house.fbx', height: 7, surfaces: { 0: 'thatch-cutout', 1: 'boards' } },
  { key: 'silo', name: 'Granary', file: 'silo/model/silo.fbx', height: 8, surfaces: { 0: 'boards', 1: 'thatch', 2: 'thatch-cutout' } },
  { key: 'windmill', name: 'Windmill', file: 'windmill/model/construction.fbx', sails: 'windmill/model/wings.fbx', height: 12, surfaces: { 0: 'boards' } },
]

/**
 * Convert every prop. Returns per prop `{ ...spec, parts: [{ name, part, surface }], sails?, hub?, size }`
 * with positions in metres, the base centre of the body on the origin.
 */
export async function buildProps(root, propsDir) {
  const ajs = await loadAssimp(root)
  const out = []
  for (const spec of PROPS) {
    let body = mergeByMaterial(partsOf(await toGltf(ajs, path.join(propsDir, spec.file))))
    if (spec.decimate) body = body.map(p => decimate(root, p, spec.decimate))
    const sails = spec.sails ? mergeByMaterial(partsOf(await toGltf(ajs, path.join(propsDir, spec.sails)))) : null

    // The scale: fixed, or whatever brings the whole prop (sails included) to its stated height.
    let scale = spec.scale
    if (!scale) {
      const b = boundsOf(body)
      let top = b.max[1]
      if (sails) top = Math.max(top, HUB[1] + boundsOf(sails).max[1])
      scale = spec.height / (top - b.min[1])
    }

    // Body to its base centre; the sails to the hub, expressed in the body's normalized frame.
    const before = boundsOf(body)
    const offset = [(before.min[0] + before.max[0]) / 2, before.min[1], (before.min[2] + before.max[2]) / 2]
    normalizeParts(body, { scale })
    const entry = {
      ...spec, scale,
      parts: body.map((p, i) => ({ name: body.length > 1 ? `${spec.name} ${i + 1}` : spec.name, part: p, surface: spec.surfaces[p.material] ?? 'boards' })),
    }
    if (sails) {
      for (const p of sails) for (let k = 0; k < p.positions.length; k++) p.positions[k] *= scale
      entry.sails = sails.map(p => ({ name: 'Sails', part: p, surface: spec.surfaces[p.material] ?? 'boards' }))
      entry.hub = HUB.map((v, a) => (v - offset[a]) * scale)
    }
    const all = [...entry.parts, ...(entry.sails ?? [])].map(p => p.part)
    entry.size = boundsOf(entry.parts.map(p => p.part)).size
    entry.triangles = triangles(all)
    out.push(entry)
  }
  return out
}
