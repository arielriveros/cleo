// The valley's landscape material, its trail mask, and the CPU copy of where each surface shows.
//
// One landscape material, eleven surfaces, bottom to top:
//
//   Ground        brown_mud_leaves    the base: covers everything nothing else covers
//   Dirt          dirt                paint-only: patches of bare earth through the meadow and worn ground
//                                     about the buildings, from a noise-painted mask (a rule's noise only
//                                     moves a transition, so it cannot open patches in flat full coverage)
//   Rocky Dirt    rocks_ground_05     the mid slopes, ~24-36°, below the rock: where the moss rocks lie
//   Forest Floor  forest_leaves_02    paint-only (`manual`): the leaf litter under the trees, from a mask
//                                     painted around every trunk the scatter placed; the ferns grow on it
//   Rock          rock_05             slope >= ~36°: the cliff walls, buttresses and every steep mountain face
//   Snow          snow_02             above ~250 m, but only where flatter than ~42°, so cliffs stay rock
//   Pond Clay     clay_plaster        paint-only: the pond's basin, below the waterline
//   Shore Sand    coast_sand_02       paint-only: the pond's bank, a ring about the waterline
//   Dirt Road     dirt                paint-only: the lesser roads and the forest tracks
//   Trail         rocky_trail_02      paint-only: the main and side roads, the ones the heightmap was graded for
//   Stone Path    concrete_rock_path  paint-only: the footpaths from each building's door to the road
//
// The rules are in the units the engine's landscape material authors them in (metres above the
// landscape origin, degrees), and `surfaceWeights` evaluates them with the engine's OWN functions out of
// src/terrain/terrainLayers.ts (surfaceAlpha, ruleNoise, compositeWeights) — the CPU copy the shader is
// tested against. That is what lets the pre-baked foliage below stay off the rock, the snow and the
// roads exactly where the renderer will draw them.

import path from 'path'
import { moduleRegistry } from '../exampleKit/tsLoader.mjs'
import { ROADS, TERRAIN, catmullRom, distanceToPolyline } from './layout.mjs'

/** The mask resolution the engine gives a 2049² landscape: defaultMaskResolution(2049) = min(1024, 2·2048). */
export const MASK_RES = 1024

export function loadLayerMath(root) {
  return moduleRegistry()(path.join(root, 'src', 'terrain', 'terrainLayers.ts'))
}

const rule = (r = {}) => ({
  elevation: { enabled: false, min: 0, max: 100, falloff: 5, ...r.elevation },
  slope: { enabled: false, min: 30, max: 90, falloff: 5, ...r.slope },
  noise: { amount: 0, scale: 8, seed: 0, ...r.noise },
  heightBlend: r.heightBlend ?? 0,
  opacity: r.opacity ?? 1,
})

/** Repeats across the whole landscape for a texture that should repeat every `metres`. */
const tilingFor = (metres) => Math.round(TERRAIN.size / metres)

/** A plain PBR surface material in Material.serialize()'s pbr shape. */
function surface(tex, extra = {}) {
  return {
    type: 'pbr', baseColor: extra.tint ?? [1, 1, 1], metallic: 0, roughness: 1, reflectance: 0.5, opacity: 1,
    emissiveFactor: [0, 0, 0], emissiveIntensity: 1, displacementScale: 0.05, depthSpace: 'uv',
    textures: {
      baseColorTexture: tex.diff, metallicRoughnessTexture: tex.arm, occlusionMap: tex.arm,
      normalMap: tex.nor, displacementMap: tex.disp,
    },
    config: { side: 'front', wireframe: false, transparent: false, castShadow: true, probeable: true },
  }
}

/**
 * The landscape material, as TerrainMaterial.serialize() writes it.
 *
 * @param tex     ground/rock/snow/trail -> { diff, nor, arm, disp } texture ids
 * @param foliage ground foliage rules (grass + pines), library-linked by modelId
 */
export function valleyTerrainMaterial(tex, foliage, grassNames, { rockFoliage = [], forestFoliage = [] } = {}) {
  const base = surface(tex.ground)
  return {
    ...base,
    terrainMaterial: true,
    tiling: tilingFor(6),
    auto: false, hRange: [0, 100], sRange: [0, 1],
    displacementScale: 0.05, invertHeight: false, heightBlend: 0,
    foliageInclude: [], foliageExclude: [],
    groundFoliageInclude: foliage,
    rule: rule(),
    allowFoliage: true, surfaceMaterialId: null, normalStrength: 1, antiTiling: 0.6,
    slots: [
      {
        id: DIRT_SLOT, name: 'Dirt', material: surface(tex.dirt), surfaceMaterialId: null, tiling: tilingFor(5),
        rule: rule({ noise: { amount: 0.4, scale: 4, seed: 31 }, heightBlend: 0.5 }),
        allowFoliage: false, manual: true, normalStrength: 1, antiTiling: 0.5,
      },
      {
        id: ROCKY_DIRT_SLOT, name: 'Rocky Dirt', material: surface(tex.rockydirt), surfaceMaterialId: null, tiling: tilingFor(5),
        rule: rule({
          slope: { enabled: true, min: 24, max: 90, falloff: 6 },
          elevation: { enabled: true, min: -100, max: 190, falloff: 30 },
          noise: { amount: 0.5, scale: 9, seed: 17 }, heightBlend: 0.4,
        }),
        // Its own foliage only: the moss rocks, placed where this surface clearly wins.
        allowFoliage: false, manual: false, normalStrength: 1.1, antiTiling: 0.5,
        foliageInclude: rockFoliage,
      },
      {
        id: FOREST_SLOT, name: 'Forest Floor', material: surface(tex.forest), surfaceMaterialId: null, tiling: tilingFor(4),
        rule: rule({ noise: { amount: 0.45, scale: 5, seed: 23 }, heightBlend: 0.35 }),
        // Its own foliage: the ferns and fallen branches of the undergrowth.
        allowFoliage: false, manual: true, normalStrength: 1, antiTiling: 0.5,
        foliageInclude: forestFoliage,
      },
      {
        id: 'slot_rock', name: 'Rock', material: surface(tex.rock), surfaceMaterialId: null, tiling: tilingFor(9),
        rule: rule({ slope: { enabled: true, min: 36, max: 90, falloff: 8 }, noise: { amount: 0.55, scale: 7, seed: 3 }, heightBlend: 0.35 }),
        allowFoliage: false, manual: false, normalStrength: 1.2, antiTiling: 0.6,
      },
      {
        id: 'slot_snow', name: 'Snow', material: surface(tex.snow), surfaceMaterialId: null, tiling: tilingFor(10),
        rule: rule({
          elevation: { enabled: true, min: 250, max: 2000, falloff: 60 },
          slope: { enabled: true, min: 0, max: 42, falloff: 10 },
          noise: { amount: 0.6, scale: 28, seed: 7 }, heightBlend: 0.3,
        }),
        allowFoliage: false, manual: false, normalStrength: 1, antiTiling: 0.5,
      },
      {
        id: CLAY_SLOT, name: 'Pond Clay', material: surface(tex.clay), surfaceMaterialId: null, tiling: tilingFor(3),
        rule: rule({ noise: { amount: 0.3, scale: 3, seed: 41 }, heightBlend: 0.4 }),
        allowFoliage: false, manual: true, normalStrength: 1, antiTiling: 0.5,
        foliageExclude: grassNames,
      },
      {
        id: SAND_SLOT, name: 'Shore Sand', material: surface(tex.sand), surfaceMaterialId: null, tiling: tilingFor(3),
        rule: rule({ noise: { amount: 0.4, scale: 2, seed: 43 }, heightBlend: 0.5 }),
        allowFoliage: false, manual: true, normalStrength: 1, antiTiling: 0.5,
        foliageExclude: grassNames,
      },
      {
        id: DIRT_ROAD_SLOT, name: 'Dirt Road', material: surface(tex.dirt), surfaceMaterialId: null, tiling: tilingFor(4),
        rule: rule({ noise: { amount: 0.35, scale: 2.5, seed: 47 }, heightBlend: 0.45 }),
        allowFoliage: false, manual: true, normalStrength: 1, antiTiling: 0.4,
        foliageExclude: grassNames,
      },
      {
        id: TRAIL_SLOT, name: 'Trail', material: surface(tex.trail), surfaceMaterialId: null, tiling: tilingFor(4),
        rule: rule({ noise: { amount: 0.35, scale: 2.5, seed: 11 }, heightBlend: 0.45 }),
        allowFoliage: false, manual: true, normalStrength: 1, antiTiling: 0.4,
        // Keep the small plants off the roads wherever the trail shows at all (weight >= 0.15).
        foliageExclude: grassNames,
      },
      {
        id: PATH_SLOT, name: 'Stone Path', material: surface(tex.path), surfaceMaterialId: null, tiling: tilingFor(3),
        rule: rule({ noise: { amount: 0.25, scale: 2, seed: 53 }, heightBlend: 0.5 }),
        allowFoliage: false, manual: true, normalStrength: 1.1, antiTiling: 0.4,
        foliageExclude: grassNames,
      },
    ],
  }
}

export const TRAIL_SLOT = 'slot_trail'
export const TRAIL_CHANNEL = 0
export const FOREST_SLOT = 'slot_forest'
export const FOREST_CHANNEL = 1
export const DIRT_ROAD_SLOT = 'slot_dirtroad'
export const DIRT_ROAD_CHANNEL = 2
export const PATH_SLOT = 'slot_path'
export const PATH_CHANNEL = 3
export const CLAY_SLOT = 'slot_clay'
export const CLAY_CHANNEL = 4
export const SAND_SLOT = 'slot_sand'
export const SAND_CHANNEL = 5
export const DIRT_SLOT = 'slot_dirt'
export const DIRT_CHANNEL = 6
export const ROCKY_DIRT_SLOT = 'slot_rockydirt'
/** Which mask channel paints each manual slot -- the material's `slotChannels`. */
export const SLOT_CHANNELS = {
  [TRAIL_SLOT]: TRAIL_CHANNEL, [FOREST_SLOT]: FOREST_CHANNEL, [DIRT_ROAD_SLOT]: DIRT_ROAD_CHANNEL,
  [PATH_SLOT]: PATH_CHANNEL, [CLAY_SLOT]: CLAY_CHANNEL, [SAND_SLOT]: SAND_CHANNEL, [DIRT_SLOT]: DIRT_CHANNEL,
}
/** Seven painted channels: two RGBA slices, stored slice-major as MaskGrid keeps them. */
export const MASK_SLICES = 2

/** Byte offset of `channel` at mask texel (r, c). */
const maskIndex = (r, c, channel) => {
  const R = MASK_RES
  return Math.floor(channel / 4) * R * R * 4 + (r * R + c) * 4 + (channel % 4)
}
const smooth = (e0, e1, x) => { const k = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return k * k * (3 - 2 * k) }

/**
 * Paint the forest floor into `data`'s FOREST_CHANNEL around every trunk: full litter within `inner` metres
 * of a pine, fading out by `outer`. Run after the pines are placed (the litter is where they stand).
 */
export function paintForestFloor(data, trunks, inner = 2.5, outer = 5.5) {
  const R = MASK_RES, size = TERRAIN.size, half = size / 2, t = size / R
  for (const [x, z] of trunks) {
    const c0 = Math.max(0, Math.floor((x - outer + half) / t)), c1 = Math.min(R - 1, Math.ceil((x + outer + half) / t))
    const r0 = Math.max(0, Math.floor((z - outer + half) / t)), r1 = Math.min(R - 1, Math.ceil((z + outer + half) / t))
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const px = -half + (c + 0.5) * t, pz = -half + (r + 0.5) * t
      const d = Math.hypot(px - x, pz - z)
      if (d > outer) continue
      const v = Math.round(255 * (1 - smooth(inner, outer, d)))
      const i = maskIndex(r, c, FOREST_CHANNEL)
      if (v > data[i]) data[i] = v
    }
  }
  return data
}

/** Paint `channel` along a sampled polyline: full over 3/4 of `halfWidth`, smoothstepped to nothing by `halfWidth + blend`. */
export function paintPolyline(data, line, halfWidth, blend, channel) {
  const R = MASK_RES, size = TERRAIN.size, half = size / 2, t = size / R
  const reach = halfWidth + blend
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const [x, z] of line) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z) }
  const c0 = Math.max(0, Math.floor((minX - reach + half) / t)), c1 = Math.min(R - 1, Math.ceil((maxX + reach + half) / t))
  const r0 = Math.max(0, Math.floor((minZ - reach + half) / t)), r1 = Math.min(R - 1, Math.ceil((maxZ + reach + half) / t))
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const x = -half + (c + 0.5) * t, z = -half + (r + 0.5) * t
    const d = distanceToPolyline(x, z, line)
    if (d > reach) continue
    const v = Math.round(255 * (1 - smooth(halfWidth * 0.75, reach, d)))
    const i = maskIndex(r, c, channel)
    if (v > data[i]) data[i] = v
  }
  return data
}

/**
 * The painted-surface masks, MASK_SLICES RGBA slices, with the trail already in channel 0 along the
 * roads: full strength over each road's graded core, smoothstepped to nothing across its blend.
 */
export function trailMask() {
  const R = MASK_RES
  const data = new Uint8Array(MASK_SLICES * R * R * 4)
  for (const road of ROADS) paintPolyline(data, catmullRom(road.points, 0.5), road.halfWidth, road.blend, TRAIL_CHANNEL)
  return data
}

/** Smooth value noise, 0..1, two octaves: the dirt patches' shapes. */
function patchNoise(x, z, seed) {
  const hash = (i, j) => {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 2147483647)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const value = (x, z) => {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz)
    const a = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * u
    const b = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * u
    return a + (b - a) * v
  }
  return value(x, z) * 0.65 + value(x * 2.7 + 17.3, z * 2.7 - 5.1) * 0.35
}

/**
 * Bare dirt, channel DIRT_CHANNEL: noise patches about `scale` metres across over the flats within
 * `radius` of the centre, covering roughly `coverage` of them, plus `wear(x, z)` (0..1): the trodden
 * ground the caller marks about buildings and paths.
 */
export function paintDirtPatches(data, heights, { radius = 320, scale = 22, coverage = 0.22, maxSlope = 26, wear = () => 0 } = {}) {
  const R = MASK_RES, size = TERRAIN.size, half = size / 2, t = size / R
  const c0 = Math.floor((-radius + half) / t), c1 = Math.ceil((radius + half) / t)
  const cut = 1 - coverage
  for (let r = c0; r <= c1; r++) for (let c = c0; c <= c1; c++) {
    const x = -half + (c + 0.5) * t, z = -half + (r + 0.5) * t
    const flat = 1 - smooth(maxSlope - 6, maxSlope, heights.slopeAt(x, z))
    if (flat <= 0) continue
    const patch = smooth(cut - 0.06, cut + 0.08, patchNoise(x / scale, z / scale, 31))
    const v = Math.max(patch * 0.9, wear(x, z)) * flat
    const i = maskIndex(r, c, DIRT_CHANNEL)
    data[i] = Math.max(data[i], Math.round(255 * v))
  }
  return data
}

/**
 * The pond's two surfaces: clay over the basin, from a little below the waterline down, and sand on the
 * bank, from a little under the water to `bankHeight` above it. A slow wobble in the ring's reach keeps
 * the bank from reading as a drawn circle.
 */
export function paintPond(data, heights, pond, level, reach, { bankHeight = 0.7, bankWidth = 3.5 } = {}) {
  const R = MASK_RES, size = TERRAIN.size, half = size / 2, t = size / R
  const outer = reach + bankWidth + 1.5
  const c0 = Math.floor((pond.x - outer + half) / t), c1 = Math.ceil((pond.x + outer + half) / t)
  const r0 = Math.floor((pond.z - outer + half) / t), r1 = Math.ceil((pond.z + outer + half) / t)
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const x = -half + (c + 0.5) * t, z = -half + (r + 0.5) * t
    const d = Math.hypot(x - pond.x, z - pond.z)
    const a = Math.atan2(z - pond.z, x - pond.x)
    const edge = reach + bankWidth * (0.75 + 0.25 * Math.sin(3 * a + 1.3) * Math.cos(5 * a + 0.4))
    if (d > edge + 1.5) continue
    const above = heights.heightAt(x, z) - level
    const clay = d < reach + 0.5 ? 1 - smooth(-0.3, -0.05, above) : 0
    const sand = (1 - smooth(edge - 1.5, edge + 1.5, d)) * (1 - smooth(bankHeight * 0.6, bankHeight, above)) * smooth(-0.6, -0.2, above)
    const ci = maskIndex(r, c, CLAY_CHANNEL), si = maskIndex(r, c, SAND_CHANNEL)
    data[ci] = Math.max(data[ci], Math.round(255 * clay))
    data[si] = Math.max(data[si], Math.round(255 * sand))
  }
  return data
}

/** Bilinear mask value at world x/z — MaskGrid.sample's arithmetic. */
export function sampleMask(data, x, z, channel = TRAIL_CHANNEL) {
  const R = MASK_RES, size = TERRAIN.size
  const fx = Math.min(Math.max(((x + size / 2) / size) * R - 0.5, 0), R - 1)
  const fz = Math.min(Math.max(((z + size / 2) / size) * R - 0.5, 0), R - 1)
  const c0 = Math.floor(fx), r0 = Math.floor(fz)
  const c1 = Math.min(c0 + 1, R - 1), r1 = Math.min(r0 + 1, R - 1)
  const tx = fx - c0, tz = fz - r0
  const v = (c, r) => data[maskIndex(r, c, channel)] / 255
  const a = v(c0, r0) + (v(c1, r0) - v(c0, r0)) * tx
  const b = v(c0, r1) + (v(c1, r1) - v(c0, r1)) * tx
  return a + (b - a) * tz
}

/**
 * Final weight of each surface at a point, [ground, ...slots in order] — Terrain.layerWeightsAt's
 * `slots`, for this material (the height-blend term is the identity on the CPU, as in the engine).
 */
export function surfaceWeights(math, material, mask, heights, x, z) {
  const h = heights.heightAt(x, z)
  const slope = heights.slopeAt(x, z)
  const alphas = [1]
  for (const s of material.slots) {
    const r = math.parseBlendRule(s.rule)
    const m = s.manual ? sampleMask(mask, x, z, SLOT_CHANNELS[s.id] ?? TRAIL_CHANNEL) : 1
    const n = r.noise.amount > 0 ? math.ruleNoise(r.noise, x, z) : 0.5
    alphas.push(math.surfaceAlpha(r, m, h, slope, n))
  }
  const w = new Array(alphas.length).fill(0)
  math.compositeWeights(alphas, w)
  return w
}

/** Terrain._foliageAllowedAt for a GROUND rule named `name`: Ground must clearly dominate, nothing excludes it. */
export function groundFoliageAllowed(material, weights, name) {
  return surfaceFoliageAllowed(material, weights, name, 0)
}

/**
 * Terrain._foliageAllowedAt for a rule owned by one SURFACE (0 = ground, k = slot k-1): that surface must
 * clearly dominate (>= 0.35), and no surface present (>= 0.15) may exclude the rule by name.
 */
export function surfaceFoliageAllowed(material, weights, name, surface) {
  let best = 0
  for (let k = 1; k < weights.length; k++) if (weights[k] > weights[best]) best = k
  if (best !== surface || weights[surface] < 0.35) return false
  for (let k = 0; k < material.slots.length; k++)
    if (weights[k + 1] >= 0.15 && material.slots[k].foliageExclude?.includes(name)) return false
  return true
}
