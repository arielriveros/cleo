// The valley's foliage plumbing: plants as model-library assets and foliage-layer models, and their
// placement -- pre-baked, because opening a scene never scatters foliage. The plants themselves are the
// Foliage Creator's (creatorFoliage.mjs); the moss rocks here are the dungeon's rubble.
//
// ## Placement
//
// Seeded and deterministic. Every candidate is tested with the landscape material's own rules
// (landscape.mjs surfaceWeights), so nothing grows on the rock, the snow or a road, and against the
// props' footprints, the hamlet and the boss plaza. Y comes from the shipped 1 m surface.

import { geometryJson, mergeParts, normalizeParts, partsOf, readGltf, triangles, boundsOf } from './meshes.mjs'
import { groundFoliageAllowed, surfaceFoliageAllowed, surfaceWeights } from './landscape.mjs'
import { mat4 } from 'gl-matrix'

/** The moss rocks the dungeon uses as rubble, by their node name in rock_moss_set_02. */
export const MOSS_ROCKS = [
  { key: 'rock08', name: 'Moss Rock A' },
  { key: 'rock09', name: 'Moss Rock B' },
  { key: 'rock11', name: 'Moss Rock C' },
  { key: 'rock13', name: 'Moss Rock D' },
]

/** Small deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------------------------------
// Prototypes
// ---------------------------------------------------------------------------------------------------

/** The moss rocks, each its own part, base centre at the origin. */
export function buildMossRocks(file) {
  const doc = readGltf(file)
  const byName = new Map(doc.gltf.nodes.map((n, i) => [n.name, i]))
  return MOSS_ROCKS.map(rock => {
    const index = byName.get(`rock_moss_set_02_${rock.key}`)
    if (index === undefined) throw new Error(`no moss rock "${rock.key}" in ${file}`)
    // Its own mesh at the origin: the file's layout translation is dropped, its scale kept.
    const n = doc.gltf.nodes[index]
    const s = n.scale ?? [1, 1, 1]
    const m = mat4.fromScaling(mat4.create(), s)
    const part = mergeParts(partsOf(doc, { filter: (_, i) => i === index, transform: () => m }), rock.name, 0)
    normalizeParts([part])
    return { ...rock, part }
  })
}

// ---------------------------------------------------------------------------------------------------
// Library assets
// ---------------------------------------------------------------------------------------------------

/**
 * A model-library asset over `levels` (level 0 first): each level is a list of `{ name, part, materialId }`.
 * Level 0's nodes link their materials (`__materialId`); generated levels embed them inline, which is
 * what lodGenerate.ts writes (withLevelLinks re-links them when the editor opens the model).
 */
export function modelAsset({ id, idOf, name, levels, distances = [], cullDistance, materialJson, vars, node }) {
  const tree = (level, index) => node(name, 'node', {
    id: idOf(`model:${id}:lod${index}`),
    children: level.map(({ name: partName, part, materialId }) => node(partName, 'model', {
      id: idOf(`model:${id}:lod${index}:${partName}`),
      variables: index === 0 ? vars({ __materialId: materialId }) : {},
      model: { geometry: geometryJson(part), material: materialJson(materialId) },
      animationMappings: null, stateMachine: null, ragdoll: null,
    })),
  })
  const textureIds = new Set()
  for (const level of levels) for (const { materialId } of level) for (const t of Object.values(materialJson(materialId).textures ?? {})) if (t) textureIds.add(t)
  return {
    id, name, nodeJson: tree(levels[0], 0), textureIds: [...textureIds],
    materialIds: [...new Set(levels[0].map(l => l.materialId))], thumbnail: '',
    lods: levels.slice(1).map((level, i) => ({ generated: true, distance: distances[i], nodeJson: tree(level, i + 1) })),
    cullDistance,
  }
}

/** One foliage prototype's models per level, flattened the way foliageRules.ts bakes them. */
export function layerModels(levels, materialJson) {
  return levels.map(level => level.map(({ part, materialId }) => ({ geometry: geometryJson(part), material: materialJson(materialId) })))
}

export { triangles, boundsOf }

// ---------------------------------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------------------------------

/**
 * Jittered-grid candidates over a box at `density` per m², kept where `accept(x, z, random)` holds.
 * Returns [x, z] pairs. A jittered grid rather than pure random: no clumps, no bald patches.
 */
export function jitteredCandidates(random, box, density, accept) {
  const step = 1 / Math.sqrt(density)
  const out = []
  for (let z = box.minZ; z < box.maxZ; z += step) for (let x = box.minX; x < box.maxX; x += step) {
    const px = x + random() * step, pz = z + random() * step
    if (accept(px, pz, random)) out.push([px, pz])
  }
  return out
}

/** Stride-5 instances `[x, y, z, yaw, scale]`, base-encoded as FoliageLayer.serialize writes them. */
export function instancesBlob(points, heights, random, minScale, maxScale, sink = 0) {
  const f = new Float32Array(points.length * 5)
  points.forEach(([x, z], i) => {
    f.set([x, heights.heightAt(x, z) - sink, z, random() * Math.PI * 2, minScale + random() * (maxScale - minScale)], i * 5)
  })
  return Buffer.from(f.buffer).toString('base64')
}

/**
 * Distance, in metres, from every cell of a coarse grid to the nearest cliff (slope above `steep`), by a
 * two-pass chamfer transform. What places the pine belt at the cliff foot without trusting the rim
 * formula, which describes the heightmap BEFORE its domain warp.
 */
export function cliffDistanceField(heights, { half = 320, cell = 2, steep = 42 } = {}) {
  const n = Math.round((2 * half) / cell)
  const d = new Float32Array(n * n)
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const x = -half + (c + 0.5) * cell, z = -half + (r + 0.5) * cell
    d[r * n + c] = heights.slopeAt(x, z) > steep ? 0 : 1e9
  }
  const D = cell, Dg = cell * Math.SQRT2
  const relax = (i, j, w) => { if (d[j] + w < d[i]) d[i] = d[j] + w }
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const i = r * n + c
    if (c > 0) relax(i, i - 1, D)
    if (r > 0) { relax(i, i - n, D); if (c > 0) relax(i, i - n - 1, Dg); if (c < n - 1) relax(i, i - n + 1, Dg) }
  }
  for (let r = n - 1; r >= 0; r--) for (let c = n - 1; c >= 0; c--) {
    const i = r * n + c
    if (c < n - 1) relax(i, i + 1, D)
    if (r < n - 1) { relax(i, i + n, D); if (c < n - 1) relax(i, i + n + 1, Dg); if (c > 0) relax(i, i + n - 1, Dg) }
  }
  return (x, z) => {
    const c = Math.floor((x + half) / cell), r = Math.floor((z + half) / cell)
    if (c < 0 || r < 0 || c >= n || r >= n) return 1e9
    return d[r * n + c]
  }
}

/** Whether a ground-foliage rule may grow at x/z per the landscape material (rules + trail mask). */
export function onGround(math, material, mask, heights, name) {
  return (x, z) => groundFoliageAllowed(material, surfaceWeights(math, material, mask, heights, x, z), name)
}

/** Whether a rule owned by surface `surface` (see landscape.mjs surfaceFoliageAllowed) may grow at x/z. */
export function onSurface(math, material, mask, heights, name, surface) {
  return (x, z) => surfaceFoliageAllowed(material, surfaceWeights(math, material, mask, heights, x, z), name, surface)
}
