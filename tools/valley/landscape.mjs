// The valley's landscape material, its trail mask, and the CPU copy of where each surface shows.
//
// One landscape material, four surfaces, bottom to top:
//
//   Ground  brown_mud_leaves  the base: covers everything nothing else covers
//   Rock    rock_05           slope >= ~36°: the cliff walls, buttresses and every steep mountain face
//   Snow    snow_02           above ~250 m, but only where flatter than ~42°, so cliffs stay rock
//   Trail   rocky_trail_02    paint-only (`manual`): exactly where the roads are, from a mask
//
// The rules are in the units the engine's landscape material authors them in (metres above the
// landscape origin, degrees), and `surfaceWeights` evaluates them with the engine's OWN functions out of
// src/terrain/terrainLayers.ts (surfaceAlpha, ruleNoise, compositeWeights) — the CPU copy the shader is
// tested against. That is what lets the pre-baked foliage below stay off the rock, the snow and the
// roads exactly where the renderer will draw them.

import path from 'path'
import { moduleRegistry } from '../nightShift/tsLoader.mjs'
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
export function valleyTerrainMaterial(tex, foliage, grassNames) {
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
        id: 'slot_trail', name: 'Trail', material: surface(tex.trail), surfaceMaterialId: null, tiling: tilingFor(4),
        rule: rule({ noise: { amount: 0.35, scale: 2.5, seed: 11 }, heightBlend: 0.45 }),
        allowFoliage: false, manual: true, normalStrength: 1, antiTiling: 0.4,
        // Keep the grass off the roads wherever the trail shows at all (weight >= 0.15).
        foliageExclude: grassNames,
      },
    ],
  }
}

export const TRAIL_SLOT = 'slot_trail'
export const TRAIL_CHANNEL = 0

/**
 * The trail mask: channel 0 of a one-slice RGBA mask grid, painted along the roads. Full strength over
 * each road's graded core, smoothstepped to nothing across its blend.
 */
export function trailMask() {
  const R = MASK_RES, size = TERRAIN.size, half = size / 2, t = size / R
  const data = new Uint8Array(R * R * 4)
  const smooth = (e0, e1, x) => { const k = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return k * k * (3 - 2 * k) }
  for (const road of ROADS) {
    const line = catmullRom(road.points, 0.5)
    const reach = road.halfWidth + road.blend
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const [x, z] of line) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z) }
    const c0 = Math.max(0, Math.floor((minX - reach + half) / t)), c1 = Math.min(R - 1, Math.ceil((maxX + reach + half) / t))
    const r0 = Math.max(0, Math.floor((minZ - reach + half) / t)), r1 = Math.min(R - 1, Math.ceil((maxZ + reach + half) / t))
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const x = -half + (c + 0.5) * t, z = -half + (r + 0.5) * t
      const d = distanceToPolyline(x, z, line)
      if (d > reach) continue
      const v = Math.round(255 * (1 - smooth(road.halfWidth * 0.75, reach, d)))
      const i = (r * R + c) * 4 + TRAIL_CHANNEL
      if (v > data[i]) data[i] = v
    }
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
  const v = (c, r) => data[(r * R + c) * 4 + channel] / 255
  const a = v(c0, r0) + (v(c1, r0) - v(c0, r0)) * tx
  const b = v(c0, r1) + (v(c1, r1) - v(c0, r1)) * tx
  return a + (b - a) * tz
}

/**
 * Final weight of each surface at a point, [ground, rock, snow, trail] — Terrain.layerWeightsAt's
 * `slots`, for this material (the height-blend term is the identity on the CPU, as in the engine).
 */
export function surfaceWeights(math, material, mask, heights, x, z) {
  const h = heights.heightAt(x, z)
  const slope = heights.slopeAt(x, z)
  const alphas = [1]
  for (const s of material.slots) {
    const r = math.parseBlendRule(s.rule)
    const m = s.manual ? sampleMask(mask, x, z) : 1
    const n = r.noise.amount > 0 ? math.ruleNoise(r.noise, x, z) : 0.5
    alphas.push(math.surfaceAlpha(r, m, h, slope, n))
  }
  const w = new Array(alphas.length).fill(0)
  math.compositeWeights(alphas, w)
  return w
}

/** Terrain._foliageAllowedAt for a GROUND rule named `name`: Ground must clearly dominate, nothing excludes it. */
export function groundFoliageAllowed(material, weights, name) {
  let best = 0
  for (let k = 1; k < weights.length; k++) if (weights[k] > weights[best]) best = k
  if (best !== 0 || weights[0] < 0.35) return false
  for (let k = 0; k < material.slots.length; k++)
    if (weights[k + 1] >= 0.15 && material.slots[k].foliageExclude?.includes(name)) return false
  return true
}
