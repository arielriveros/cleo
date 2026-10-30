// The valley's plants: three grass patches and one pine, as model-library assets with generated LOD
// levels, plus their placement — pre-baked, because opening a scene never scatters foliage.
//
// ## Prototypes
//
// The grass glTF is 17 single clumps, 4-32 cm tall, laid out in a row. Each prototype here is a PATCH: five
// or six clumps arranged in a ~0.4 m disc and scaled to meadow height (~0.35-0.7 m), so one instance reads
// as a tuft rather than a single blade, and the scale lives in the geometry — never in the instance range.
// (An instance scale multiplies a mesh but IS the size of an impostor card; keeping the authored size
// right keeps the two from disagreeing.)
//
// The pine is 477k triangles (133k bark, 344k needle cards), drawn at full detail as LOD0. LOD1 and LOD2
// (15% and 5%) come from the editor's own QEM simplifier, so the library asset is what "Generate LOD
// levels…" would have made, and past those an octahedral impostor (tools/valley/bakeOctahedral.ts, the
// engine's own baker) takes over.
//
// ## Placement
//
// Seeded and deterministic. Every candidate is tested with the landscape material's own rules
// (landscape.mjs surfaceWeights), so nothing grows on the rock, the snow or a road, and against the
// props' footprints, the hamlet and the boss plaza. Y comes from the shipped 1 m surface.

import { decimate, geometryJson, mergeParts, normalizeParts, partsOf, readGltf, triangles, boundsOf } from './meshes.mjs'
import { groundFoliageAllowed, surfaceFoliageAllowed, surfaceWeights } from './landscape.mjs'
import { mat4 } from 'gl-matrix'

export const GRASS_PATCHES = [
  { key: 'a', name: 'Meadow Grass A', clumps: ['large_a', 'mid_a', 'tall_a', 'small_a', 'tiny_a'] },
  { key: 'b', name: 'Meadow Grass B', clumps: ['large_b', 'mid_b', 'tall_b', 'small_b', 'tiny_b', 'tiny_c'] },
  { key: 'c', name: 'Meadow Grass C', clumps: ['large_c', 'mid_c', 'tall_c', 'tiny_d', 'tiny_e', 'tiny_f'] },
]

/** Clump height multiplier: the source clumps are 4-32 cm; meadow grass here is ~0.3-0.65 m. */
const GRASS_SCALE = 1.8
/**
 * LOD ratios and switch distances. LOD0 is the source model at full detail for both; grass ends at
 * `GRASS_CULL`, and past `PINE_BILLBOARD` a pine is its baked octahedral impostor out to the horizon. That
 * impostor is lit like the mesh and right from every side and from above, so it takes over at 50 m where the
 * flat card it replaced needed 70: a 256 px view of a ~15 m pine still out-resolves the tree on screen there.
 */
const GRASS_LODS = [[0.08, 6], [0.025, 15]]
export const GRASS_CULL = 20
const PINE_LODS = [[0.15, 15], [0.05, 35]]
export const PINE_BILLBOARD = 50
export const PINE_CULL = 450
/** The celandine flowers share the meadow's LOD ladder and end with it. */
export const FLOWER_CULL = GRASS_CULL
/** Moss rocks: full detail close up, then 25% and 8%; visible a long way, they are big and still. */
const ROCK_LODS = [[0.25, 25], [0.08, 60]]
export const ROCK_CULL = 120

/** Celandine clumps (build/foliage/celandine_01_1k.gltf), grouped like the grass patches. */
export const FLOWER_PATCHES = [
  { key: 'a', name: 'Celandine A', clumps: ['a', 'c', 'e'] },
  { key: 'b', name: 'Celandine B', clumps: ['b', 'd', 'a'] },
]
/** The source plants are 12-19 cm; a celandine in flower stands a little taller than that in the meadow. */
const FLOWER_SCALE = 1.4

/** The moss rocks used, by their node name in rock_moss_set_02, and which get a collider. */
export const MOSS_ROCKS = [
  { key: 'rock08', name: 'Moss Rock A', collide: false },
  { key: 'rock09', name: 'Moss Rock B', collide: false },
  { key: 'rock11', name: 'Moss Rock C', collide: true },
  { key: 'rock13', name: 'Moss Rock D', collide: true },
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

/** Each grass patch as one merged part (one material). */
export function buildGrassPatches(file) {
  const doc = readGltf(file)
  const byName = new Map(doc.gltf.nodes.map((n, i) => [n.name, i]))
  return GRASS_PATCHES.map((patch, pi) => {
    const random = rng(0x9a55 + pi)
    const parts = []
    patch.clumps.forEach((clump, ci) => {
      const index = byName.get(`grass_medium_01_${clump}_LOD0`)
      if (index === undefined) throw new Error(`no grass clump "${clump}" in ${file}`)
      // Ring placement: the first clump at the centre, the rest around it at 0.10-0.20 m (before scale).
      const a = (ci / patch.clumps.length) * Math.PI * 2 + random() * 0.8
      const r = ci === 0 ? 0 : 0.1 + random() * 0.1
      const m = mat4.create()
      mat4.scale(m, m, [GRASS_SCALE, GRASS_SCALE * (0.9 + random() * 0.25), GRASS_SCALE])
      mat4.translate(m, m, [Math.cos(a) * r, 0, Math.sin(a) * r])
      mat4.rotateY(m, m, random() * Math.PI * 2)
      parts.push(...partsOf(doc, { filter: (_, i) => i === index, transform: () => m }))
    })
    const merged = mergeParts(parts, patch.name, 0)
    normalizeParts([merged])
    return { ...patch, part: merged }
  })
}

/** Each celandine patch as one merged part: a few clumps in a small ring, like a grass patch. */
export function buildFlowerPatches(file) {
  const doc = readGltf(file)
  const byName = new Map(doc.gltf.nodes.map((n, i) => [n.name, i]))
  return FLOWER_PATCHES.map((patch, pi) => {
    const random = rng(0xf10e + pi)
    const parts = []
    patch.clumps.forEach((clump, ci) => {
      const index = byName.get(`celandine_01_${clump}_LOD0`)
      if (index === undefined) throw new Error(`no celandine clump "${clump}" in ${file}`)
      const a = (ci / patch.clumps.length) * Math.PI * 2 + random() * 0.8
      const r = ci === 0 ? 0 : 0.08 + random() * 0.07
      const m = mat4.create()
      mat4.scale(m, m, [FLOWER_SCALE, FLOWER_SCALE * (0.9 + random() * 0.2), FLOWER_SCALE])
      mat4.translate(m, m, [Math.cos(a) * r, 0, Math.sin(a) * r])
      mat4.rotateY(m, m, random() * Math.PI * 2)
      // `transform` REPLACES the node's world matrix, so the file's row layout along x is dropped.
      parts.push(...partsOf(doc, { filter: (_, i) => i === index, transform: () => m }))
    })
    const merged = mergeParts(parts, patch.name, 0)
    normalizeParts([merged])
    return { ...patch, part: merged }
  })
}

/** The moss rocks, each its own part, base centre at the origin (sunk a little at placement). */
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

/** The pine as [bark, needles] parts, base centre of the trunk at the origin. */
export function buildPine(file) {
  const parts = partsOf(readGltf(file))
  const bark = mergeParts(parts.filter(p => p.material === 0), 'Bark', 0)
  const needles = mergeParts(parts.filter(p => p.material === 1), 'Needles', 1)
  normalizeParts([bark, needles], { reference: [bark] })
  return { bark, needles }
}

/**
 * Keep one connected piece (a leaf card, a twig) in `keep`, chosen by a seeded draw, each kept piece
 * scaled about its own centre by `grow` so the crown keeps its coverage with fewer, larger cards. A
 * simplifier cannot do this: QEM collapses every card toward a sliver at once, and a crown of slivers
 * reads as bare branches.
 */
export function thinPieces(part, keep, grow, seed) {
  const n = part.positions.length / 3
  const parent = new Int32Array(n).map((_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  for (let i = 0; i < part.indices.length; i += 3) {
    const a = find(part.indices[i]), b = find(part.indices[i + 1])
    parent[b] = a
    parent[find(part.indices[i + 2])] = a
  }
  const random = rng(seed)
  const kept = new Map()   // root -> keep?
  const centre = new Map() // root -> [x, y, z, count]
  for (let v = 0; v < n; v++) {
    const r = find(v)
    if (!kept.has(r)) kept.set(r, random() < keep)
    if (!kept.get(r)) continue
    const c = centre.get(r) ?? [0, 0, 0, 0]
    c[0] += part.positions[v * 3]; c[1] += part.positions[v * 3 + 1]; c[2] += part.positions[v * 3 + 2]; c[3]++
    centre.set(r, c)
  }
  const remap = new Int32Array(n).fill(-1)
  const positions = [], normals = [], uvs = []
  for (let v = 0; v < n; v++) {
    const r = find(v)
    if (!kept.get(r)) continue
    const c = centre.get(r)
    remap[v] = positions.length / 3
    for (let k = 0; k < 3; k++) positions.push(c[k] / c[3] + (part.positions[v * 3 + k] - c[k] / c[3]) * grow)
    normals.push(part.normals[v * 3], part.normals[v * 3 + 1], part.normals[v * 3 + 2])
    uvs.push(part.uvs[v * 2], part.uvs[v * 2 + 1])
  }
  const indices = []
  for (let i = 0; i < part.indices.length; i += 3) {
    if (remap[part.indices[i]] < 0) continue
    indices.push(remap[part.indices[i]], remap[part.indices[i + 1]], remap[part.indices[i + 2]])
  }
  return {
    ...part, positions: Float32Array.from(positions), normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices),
  }
}

/**
 * `part` without the connected pieces (leaf cards) that hang in the air: a piece is kept when one of its
 * vertices lies within `reach` of the wood in `anchors` (sampled along every edge, so a long decimated
 * twig still holds the leaves along it). Simplifying the branches loses the finest twigs, and the cards
 * they carried would float.
 */
export function anchoredPieces(part, anchors, reach) {
  const cell = reach
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  const wood = new Map()
  const add = (x, y, z) => {
    const k = key(x, y, z)
    let list = wood.get(k)
    if (!list) wood.set(k, list = [])
    list.push(x, y, z)
  }
  for (const a of anchors) {
    const P = a.positions, I = a.indices
    for (let i = 0; i < I.length; i += 3) for (let e = 0; e < 3; e++) {
      const p = I[i + e] * 3, q = I[i + (e + 1) % 3] * 3
      const len = Math.hypot(P[q] - P[p], P[q + 1] - P[p + 1], P[q + 2] - P[p + 2])
      const steps = Math.max(1, Math.ceil(len / (reach / 2)))
      for (let s = 0; s < steps; s++) {
        const t = s / steps
        add(P[p] + (P[q] - P[p]) * t, P[p + 1] + (P[q + 1] - P[p + 1]) * t, P[p + 2] + (P[q + 2] - P[p + 2]) * t)
      }
    }
  }
  const near = (x, y, z) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = wood.get(`${cx + dx},${cy + dy},${cz + dz}`)
      if (!list) continue
      for (let i = 0; i < list.length; i += 3)
        if ((list[i] - x) ** 2 + (list[i + 1] - y) ** 2 + (list[i + 2] - z) ** 2 <= reach * reach) return true
    }
    return false
  }

  const n = part.positions.length / 3
  const parent = new Int32Array(n).map((_, i) => i)
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  for (let i = 0; i < part.indices.length; i += 3) {
    const a = find(part.indices[i]), b = find(part.indices[i + 1])
    parent[b] = a
    parent[find(part.indices[i + 2])] = a
  }
  const anchored = new Set()
  for (let v = 0; v < n; v++) {
    const r = find(v)
    if (!anchored.has(r) && near(part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2])) anchored.add(r)
  }
  const indices = []
  for (let i = 0; i < part.indices.length; i += 3)
    if (anchored.has(find(part.indices[i]))) indices.push(part.indices[i], part.indices[i + 1], part.indices[i + 2])
  return { ...part, indices: Uint32Array.from(indices) }
}

/**
 * The jacaranda as [trunk, branches, leaves] parts, base centre of the trunk at the origin, brought down
 * from the scan's 3.9M triangles: a tenth of the leaf cards (grown to cover), then QEM on all three, and
 * the cards whose twig the simplified branches lost dropped (`anchoredPieces`). The trunk and branches
 * keep enough of the scan (a tenth, a thirtieth) to stay round and carry their leaves. Still well under the
 * pine's 477k: a foliage layer embeds every level of its mesh in the scene, and the Valley's scene JSON
 * already sits near V8's ~512 MB string ceiling (bundleAssetsRealProject.test.ts).
 * Its glTF material order is branches, trunk, leaves.
 */
export function buildJacaranda(root, file, { leafKeep = 0.1, leafGrow = 1.9, leafRatio = 0.2, branchRatio = 0.035, trunkRatio = 0.1, leafReach = 0.5 } = {}) {
  const parts = partsOf(readGltf(file))
  const pick = (material) => mergeParts(parts.filter(p => p.material === material), undefined, material)
  const branches = decimate(root, { ...pick(0), name: 'Branches' }, branchRatio)
  const trunk = decimate(root, { ...pick(1), name: 'Trunk' }, trunkRatio)
  const leaves = anchoredPieces(decimate(root, { ...thinPieces(pick(2), leafKeep, leafGrow, 0x1ac4), name: 'Leaves' }, leafRatio), [trunk, branches], leafReach)
  normalizeParts([trunk, branches, leaves], { reference: [trunk] })
  return { trunk, branches, leaves }
}

/**
 * Named nodes of a Poly Haven plant set as their own parts, each at the origin (the file lays its
 * variants out in a row), merged per material when a variant has more than one.
 */
export function buildPlantSet(file, prefix, variants, scale = 1) {
  const doc = readGltf(file)
  const byName = new Map(doc.gltf.nodes.map((n, i) => [n.name, i]))
  return variants.map(v => {
    const index = byName.get(`${prefix}_${v.key}`) ?? byName.get(v.node)
    if (index === undefined) throw new Error(`no "${prefix}_${v.key}" in ${file}`)
    const m = mat4.fromScaling(mat4.create(), [scale, scale, scale])
    const parts = partsOf(doc, { filter: (_, i) => i === index, transform: () => m })
    const byMaterial = new Map()
    for (const p of parts) byMaterial.set(p.material, [...(byMaterial.get(p.material) ?? []), p])
    const merged = [...byMaterial].map(([mat, ps]) => mergeParts(ps, `${v.name} ${mat}`, mat))
    normalizeParts(merged)
    return { ...v, parts: merged }
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

export function grassLevels(root, patch, materialId) {
  const lv = [[{ name: 'Grass', part: patch.part, materialId }]]
  for (const [ratio] of GRASS_LODS) lv.push([{ name: 'Grass', part: decimate(root, patch.part, ratio), materialId }])
  return { levels: lv, distances: GRASS_LODS.map(([, d]) => d) }
}

export function flowerLevels(root, patch, materialId) {
  const lv = [[{ name: 'Flowers', part: patch.part, materialId }]]
  for (const [ratio] of GRASS_LODS) lv.push([{ name: 'Flowers', part: decimate(root, patch.part, ratio), materialId }])
  return { levels: lv, distances: GRASS_LODS.map(([, d]) => d) }
}

export function rockLevels(root, rock, materialId) {
  const lv = [[{ name: 'Rock', part: rock.part, materialId }]]
  for (const [ratio] of ROCK_LODS) lv.push([{ name: 'Rock', part: decimate(root, rock.part, ratio), materialId }])
  return { levels: lv, distances: ROCK_LODS.map(([, d]) => d) }
}

export function pineLevels(root, pine, barkId, needlesId) {
  const level = (ratio) => [
    { name: 'Bark', part: decimate(root, pine.bark, ratio), materialId: barkId },
    { name: 'Needles', part: decimate(root, pine.needles, ratio), materialId: needlesId },
  ]
  return { levels: [level(1), ...PINE_LODS.map(([r]) => level(r))], distances: PINE_LODS.map(([, d]) => d) }
}

/** The jacaranda on the pine's ladder: the same 15% and 5% levels, the same impostor hand-over. */
export function jacarandaLevels(root, tree, { trunkId, branchesId, leavesId }) {
  const level = (ratio) => [
    { name: 'Trunk', part: decimate(root, tree.trunk, ratio), materialId: trunkId },
    { name: 'Branches', part: decimate(root, tree.branches, ratio), materialId: branchesId },
    { name: 'Leaves', part: decimate(root, tree.leaves, ratio), materialId: leavesId },
  ]
  return { levels: [level(1), ...PINE_LODS.map(([r]) => level(r))], distances: PINE_LODS.map(([, d]) => d) }
}

/** Undergrowth (ferns, bushes, fallen branches): full detail close up, then two QEM levels. */
export const UNDERGROWTH_LODS = [[0.3, 8], [0.1, 18]]
export const BUSH_LODS = [[0.3, 15], [0.1, 35]]
export const FERN_CULL = 35
export const BUSH_CULL = 90
export const BRANCH_CULL = 30

/**
 * `parts` ([{ name, part, materialId }]) at `base` of their detail (1: the scan as it is) and at each
 * `lods` ratio of that.
 */
export function plantLevels(root, parts, lods, base = 1) {
  const level = (ratio) => parts.map(p => ({ ...p, part: decimate(root, p.part, ratio * base) }))
  return { levels: [level(1), ...lods.map(([r]) => level(r))], distances: lods.map(([, d]) => d) }
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
