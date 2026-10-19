#!/usr/bin/env node
// Authors the "Valley" example into editor/public/examples/valley/.
//
//     python tools/valley/prepare.py                         # once: textures -> build/valley_prepared/
//     node --max-old-space-size=8192 tools/valley/build.mjs
//     npm --prefix editor run examples:list                  # regenerates the gallery index
//
// The Hollow Keep souls-like, moved outdoors. Every playable element — the player, both weapons, the four
// enemy types, the Warden, the bonfire, the fog gate, the lever and gate, messages, pickups, the HUD — is
// the souls demo's own, imported from tools/soulsDemo/build.mjs and linked to the same templates. What is
// new is the level: a 2 km landscape from build/valley_height_4097_16bit.png with a four-surface landscape
// material (ground, rock, snow, and painted trails along the roads), pre-scattered meadow grass and pines,
// and four FBX buildings on the pads the heightmap was flattened for.
//
// Positions come from the map's technical reference (layout.mjs); every height is sampled from the
// heightmap (heights.mjs). The source art is in build/, which is gitignored: this is run by hand and its
// OUTPUT is committed, like tools/nightShift/importZombie.mjs.

import fs from 'fs'
import { spawnSync } from 'child_process'
import path from 'path'
import { node, vars, loadScriptReflector, mb } from '../nightShift/bundle.mjs'
import { ASSET_HASH_VERSION } from '../nightShift/editorConstants.mjs'
import * as souls from '../soulsDemo/build.mjs'
import { loadHeights } from './heights.mjs'
import {
  GATE_PLAZA, HAMLET, NOTCH_HALF_WIDTH, POND, ROADS, SPAWN, SUN_TRAVEL, TERRAIN, WATCHTOWER,
  catmullRom, distanceToPolyline, rimRadius,
} from './layout.mjs'
import { MASK_RES, TRAIL_CHANNEL, TRAIL_SLOT, loadLayerMath, sampleMask, surfaceWeights, trailMask, valleyTerrainMaterial } from './landscape.mjs'
import {
  GRASS_CULL, PINE_CULL, buildGrassPatches, buildPine, cliffDistanceField, grassLevels, instancesBlob,
  jitteredCandidates, layerModels, modelAsset, onGround, pineLevels, rng, triangles,
} from './foliage.mjs'
import { buildProps } from './props.mjs'
import { WATER_SOURCE, WATER_UNIFORMS } from './water.mjs'
import { boundsOf, convexShape, geometryJson } from './meshes.mjs'

const { ROOT, stableId: soulsId, clone, matJson, material, textures, LEVEL, linkInstance, withScript } = souls
const BUILD = path.join(ROOT, 'build')
const PREPARED = path.join(BUILD, 'valley_prepared')
const OUT = path.join(ROOT, 'editor', 'public', 'examples', 'valley')
const PROJECT_NAME = 'Valley'

/** Ids for everything this example adds, in their own namespace beside the souls content's. */
const id = (key) => soulsId('valley:' + key)
const SCENE_ID = id('scene')

if (!fs.existsSync(PREPARED)) throw new Error('no build/valley_prepared — run `python tools/valley/prepare.py` first')

const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

// =====================================================================================================
// Textures and materials
// =====================================================================================================

const TEXTURE_ENTRIES = []
/** A prepared texture: repeat-wrapped and mip-mapped (every map here tiles or is sampled at distance). */
function tex(file, folder, name) {
  const texId = id(`texture:${file}`)
  const ext = path.extname(file).slice(1)
  textures.add(texId, path.join(PREPARED, file), { wrapping: 'repeat', mipMap: true }, ext === 'jpg' ? 'image/jpeg' : 'image/png')
  TEXTURE_ENTRIES.push({ folder, name, id: texId, ext })
  return texId
}

const LANDSCAPE = '/Environment/Landscape'
const FOLIAGE = '/Environment/Foliage'
const BUILDINGS = '/Environment/Buildings'

const groundTex = (prefix, label) => ({
  diff: tex(`${prefix}_diff.jpg`, `${LANDSCAPE}/Textures`, `${label} Base Color`),
  nor: tex(`${prefix}_nor.png`, `${LANDSCAPE}/Textures`, `${label} Normal`),
  arm: tex(`${prefix}_arm.jpg`, `${LANDSCAPE}/Textures`, `${label} ARM`),
  disp: tex(`${prefix}_disp.png`, `${LANDSCAPE}/Textures`, `${label} Height`),
})
const TERRAIN_TEX = {
  ground: groundTex('ground', 'Ground'), rock: groundTex('rock', 'Rock'),
  snow: groundTex('snow', 'Snow'), trail: groundTex('trail', 'Trail'),
}

/** A PBR material in Material.serialize()'s shape, with only the slots that are given. */
function pbrMaterial({ diff, nor, arm, rough, mask, side = 'front', roughness = 1, castShadow = true, tint = [1, 1, 1] }) {
  return {
    type: 'pbr', baseColor: tint, metallic: 0, roughness, reflectance: 0.5, opacity: 1,
    ...(mask ? { alphaCutoff: 0.5 } : {}),
    emissiveFactor: [0, 0, 0], emissiveIntensity: 1,
    textures: {
      baseColorTexture: diff,
      ...(arm ? { metallicRoughnessTexture: arm, occlusionMap: arm } : {}),
      ...(rough ? { roughnessMap: rough } : {}),
      normalMap: nor,
      ...(mask ? { mask } : {}),
    },
    config: { side, wireframe: false, transparent: false, castShadow, probeable: true },
  }
}
const texIdsOf = (m) => [...new Set(Object.values(m.textures).filter(Boolean))]
const addMaterial = (key, name, m) => material(`valley:${key}`, name, m, texIdsOf(m))

const MATERIAL_FOLDERS = {}
function libraryMaterial(key, name, folder, m) {
  MATERIAL_FOLDERS[name] = folder
  return addMaterial(key, name, m)
}

const GRASS_MAT = libraryMaterial('grass', 'Meadow Grass', `${FOLIAGE}/Materials`, pbrMaterial({
  diff: tex('grass_diff.jpg', `${FOLIAGE}/Textures`, 'Grass Base Color'),
  nor: tex('grass_nor.jpg', `${FOLIAGE}/Textures`, 'Grass Normal'),
  arm: tex('grass_arm.jpg', `${FOLIAGE}/Textures`, 'Grass ARM'),
  mask: tex('grass_mask.png', `${FOLIAGE}/Textures`, 'Grass Mask'),
  side: 'double', castShadow: false,
}))
const BARK_MAT = libraryMaterial('pine-bark', 'Pine Bark', `${FOLIAGE}/Materials`, pbrMaterial({
  diff: tex('pine_bark_diff.jpg', `${FOLIAGE}/Textures`, 'Pine Bark Base Color'),
  nor: tex('pine_bark_nor.png', `${FOLIAGE}/Textures`, 'Pine Bark Normal'),
  roughness: 0.85, side: 'double',
}))
const NEEDLES_MAT = libraryMaterial('pine-needles', 'Pine Needles', `${FOLIAGE}/Materials`, pbrMaterial({
  diff: tex('pine_needles_diff.jpg', `${FOLIAGE}/Textures`, 'Pine Needles Base Color'),
  nor: tex('pine_needles_nor.png', `${FOLIAGE}/Textures`, 'Pine Needles Normal'),
  mask: tex('pine_needles_mask.png', `${FOLIAGE}/Textures`, 'Pine Needles Mask'),
  roughness: 0.75, side: 'double',
}))

const BOARDS = {
  diff: tex('boards_diff.jpg', `${BUILDINGS}/Textures`, 'Boards Base Color'),
  nor: tex('boards_nor.png', `${BUILDINGS}/Textures`, 'Boards Normal'),
  rough: tex('boards_rough.jpg', `${BUILDINGS}/Textures`, 'Boards Roughness'),
}
const THATCH = {
  diff: tex('thatch_diff.jpg', `${BUILDINGS}/Textures`, 'Thatch Base Color'),
  nor: tex('thatch_nor.png', `${BUILDINGS}/Textures`, 'Thatch Normal'),
  rough: tex('thatch_rough.jpg', `${BUILDINGS}/Textures`, 'Thatch Roughness'),
}
const SURFACES = {
  house: libraryMaterial('house', 'Old House', `${BUILDINGS}/Materials`, pbrMaterial({
    diff: tex('house_diff.jpg', `${BUILDINGS}/Textures`, 'Old House Base Color'),
    nor: tex('house_nor.png', `${BUILDINGS}/Textures`, 'Old House Normal'),
    rough: tex('house_rough.jpg', `${BUILDINGS}/Textures`, 'Old House Roughness'),
  })),
  boards: libraryMaterial('boards', 'Dirty Planks', `${BUILDINGS}/Materials`, pbrMaterial({ ...BOARDS, side: 'double' })),
  thatch: libraryMaterial('thatch', 'Thatch', `${BUILDINGS}/Materials`, pbrMaterial({ ...THATCH, side: 'double' })),
  'thatch-cutout': libraryMaterial('thatch-cutout', 'Thatch (cutout)', `${BUILDINGS}/Materials`, pbrMaterial({
    ...THATCH, mask: tex('thatch_mask.png', `${BUILDINGS}/Textures`, 'Thatch Mask'), side: 'double',
  })),
}

// ----- water ---------------------------------------------------------------------------------------
//
// A forward, TRANSPARENT custom material (tools/valley/water.glsl): normal-mapped waves, Fresnel
// reflection of the pond's light probe, a sun glint, refraction of the basin floor with depth
// absorption, shore foam and a soft edge. Its WGSL is translated here, offline, because a published game
// has no translator and renders a custom material on WebGPU only from the WGSL it was saved with.

const WATER_FOLDER = '/Environment/Water'
const WATER_NORMAL = tex('water_nor.png', `${WATER_FOLDER}/Textures`, 'Water Normal')

function translateCustom(request) {
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite-node', '--config', 'vitest.config.ts', 'tools/valley/compileCustomWgsl.ts'],
    { cwd: ROOT, input: JSON.stringify(request), encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20 })
  if (res.status !== 0) throw new Error(`WGSL translation failed:\n${res.stderr}`)
  return JSON.parse(res.stdout.slice(res.stdout.indexOf('{')))
}

const WATER_MAT = (() => {
  const compiled = translateCustom({ renderMode: 'forward', fragmentSource: WATER_SOURCE, uniforms: WATER_UNIFORMS })
  const properties = Object.fromEntries(WATER_UNIFORMS.filter(u => !u.type.startsWith('sampler')).map(u => [u.name, u.value]))
  MATERIAL_FOLDERS.Water = `${WATER_FOLDER}/Materials`
  return material('valley:water', 'Water', {
    type: compiled.type, customMaterial: true,
    compiledWgsl: compiled.wgsl, compiledWgslType: compiled.type, compiledWgslHash: compiled.hash,
    renderMode: 'forward', baseType: null, fragmentSource: WATER_SOURCE, uniforms: WATER_UNIFORMS,
    properties, textures: { normalMap: WATER_NORMAL },
    // Not probeable: a probe capture has no scene buffers to refract, and the pond probe should see
    // the sky and the banks, not the water it is lighting.
    config: { side: 'double', wireframe: false, transparent: true, castShadow: false, probeable: false },
  }, [WATER_NORMAL])
})()

// The windmill's sail script, beside the souls scripts in the same library.
const reflect = loadScriptReflector(ROOT)
{
  const source = fs.readFileSync(path.join(ROOT, 'examples', 'scripts', 'ValleyWindmill.ts'), 'utf8')
  const asset = { id: id('script:ValleyWindmill'), name: 'Windmill Sails', baseType: 'node', source, kind: 'class', variables: reflect(source) }
  souls.scripts.assets.push(asset)
  souls.scripts.byFile.set('ValleyWindmill', asset)
}

// =====================================================================================================
// Heights, landscape material, trail mask
// =====================================================================================================

const heights = await loadHeights(ROOT, BUILD)
log('heights decoded')
const math = loadLayerMath(ROOT)

/**
 * The pond's water level: the LOWEST bank height on a ring just outside the basin, less 5 cm, so the
 * surface can never stand above the ground around it. Measured on the shipped (1 m) surface.
 */
const POND_LEVEL = (() => {
  let lowest = Infinity
  for (let a = 0; a < 360; a += 3) {
    const r = POND.r + 1
    lowest = Math.min(lowest, heights.heightAt(POND.x + Math.cos(a * Math.PI / 180) * r, POND.z + Math.sin(a * Math.PI / 180) * r))
  }
  return Math.round((lowest - 0.05) * 1000) / 1000
})()
const POND_HALF = POND.r + 4

/** The basin's lowest ground, and how far the water reaches from the centre (where the bank rises out). */
const POND_FLOOR = (() => {
  let lowest = Infinity
  for (let z = -POND.r; z <= POND.r; z += 0.5) for (let x = -POND.r; x <= POND.r; x += 0.5)
    lowest = Math.min(lowest, heights.heightAt(POND.x + x, POND.z + z))
  return lowest
})()
const POND_REACH = (() => {
  let reach = 0
  for (let a = 0; a < 360; a += 5) {
    const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180)
    let r = 0
    while (r < POND_HALF && heights.heightAt(POND.x + c * r, POND.z + s * r) < POND_LEVEL) r += 0.25
    reach = Math.max(reach, r)
  }
  return reach
})()

/** A flat, upward-facing grid `2 * half` across, `n` cells a side, uvs over its extent. */
function waterPlane(half, n) {
  const positions = [], normals = [], texCoords = [], indices = []
  for (let r = 0; r <= n; r++) for (let c = 0; c <= n; c++) {
    positions.push(-half + (2 * half * c) / n, 0, -half + (2 * half * r) / n)
    normals.push(0, 1, 0)
    texCoords.push(c / n, r / n)
  }
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const i = r * (n + 1) + c
    // Counter-clockwise seen from above (+Y), the engine's front face.
    indices.push(i, i + n + 1, i + 1, i + 1, i + n + 1, i + n + 2)
  }
  return { positions, normals, tangents: [], bitangents: [], texCoords, indices }
}
const mask = trailMask()
const roadLines = ROADS.map(r => catmullRom(r.points, 1))
const roadDistance = (x, z) => Math.min(...roadLines.map(l => distanceToPolyline(x, z, l)))

// =====================================================================================================
// Buildings
// =====================================================================================================

const props = await buildProps(ROOT, path.join(BUILD, 'props'))
log('props converted', props.map(p => `${p.key} ${p.triangles} tris ${p.size.map(v => v.toFixed(1)).join('x')} m`).join(', '))

/** Where each building wants to stand (reference pads / sites) and which way it faces, in radians. */
const SITES = {
  house: { x: -50, z: 30, yaw: 0.35 },
  'long-house': { x: -18, z: 44, yaw: -2.4 },   // east of the road: Cottage B's pad sits on it
  silo: { x: -58, z: 48, yaw: 0.8 },
  // The sails face the valley centre. Local -X is the sail side, and Ry(yaw) takes -X to (-cos, 0, sin).
  windmill: { x: WATCHTOWER.x, z: WATCHTOWER.z, yaw: Math.atan2(-WATCHTOWER.z, WATCHTOWER.x) },
}
/** The bonfire, by the hamlet's well, just off the road. */
const BONFIRE = { x: HAMLET.x + 6, z: HAMLET.z - 2 }

/**
 * Settle each building near its site: the spot within a few metres whose footprint is flattest, clear of
 * the roads, the bonfire and the buildings already placed. The base goes at the LOWEST ground under the
 * footprint so nothing floats; on the pads that is within a few centimetres of the rest.
 */
function placeBuildings() {
  const placed = []
  for (const p of props) {
    const site = SITES[p.key]
    const radius = Math.hypot(p.size[0], p.size[2]) / 2
    const footprint = (cx, cz, yaw) => {
      const pts = []
      const c = Math.cos(yaw), s = Math.sin(yaw)
      for (const fx of [-0.5, -0.25, 0, 0.25, 0.5]) for (const fz of [-0.5, -0.25, 0, 0.25, 0.5]) {
        const lx = fx * p.size[0], lz = fz * p.size[2]
        pts.push([cx + lx * c + lz * s, cz - lx * s + lz * c])
      }
      return pts
    }
    let best = null
    for (let dz = -10; dz <= 10; dz += 1) for (let dx = -10; dx <= 10; dx += 1) {
      const cx = site.x + dx, cz = site.z + dz
      const pts = footprint(cx, cz, site.yaw)
      const hs = pts.map(([x, z]) => heights.heightAt(x, z))
      const range = Math.max(...hs) - Math.min(...hs)
      let cost = range + Math.hypot(dx, dz) * 0.05
      if (pts.some(([x, z]) => sampleMask(mask, x, z) > 0.05)) cost += 50
      if (Math.hypot(cx - BONFIRE.x, cz - BONFIRE.z) < radius + 4) cost += 50
      for (const q of placed) if (Math.hypot(cx - q.x, cz - q.z) < radius + q.radius + 1) cost += 50
      if (!best || cost < best.cost) best = { cost, x: cx, z: cz, y: Math.min(...hs) - 0.05, range }
    }
    placed.push({ ...best, key: p.key, yaw: site.yaw, radius, prop: p })
  }
  return placed
}
const buildings = placeBuildings()
for (const b of buildings) log(`building ${b.key} at (${b.x}, ${b.y.toFixed(2)}, ${b.z}) ground range ${b.range.toFixed(2)} m${b.cost >= 50 ? '  ** CROWDED **' : ''}`)

function propModelAsset(p) {
  const assetId = id(`model:${p.key}`)
  const children = p.parts.map(({ name, part, surface }) => node(name, 'model', {
    id: id(`model:${p.key}:${name}`),
    variables: vars({ __materialId: SURFACES[surface] }),
    model: { geometry: geometryJson(part), material: matJson(SURFACES[surface]) },
    animationMappings: null, stateMachine: null, ragdoll: null,
  }))
  if (p.sails) {
    children.push(withScript(node('Sails', 'node', {
      id: id(`model:${p.key}:sails`), position: p.hub.map(v => Math.round(v * 1e4) / 1e4),
      children: p.sails.map(({ part, surface }, i) => node(`Sail ${i + 1}`, 'model', {
        id: id(`model:${p.key}:sail:${i}`),
        // The sails' own frame is centred on the hub, so they hang on the node with no offset.
        variables: vars({ __materialId: SURFACES[surface] }),
        model: { geometry: geometryJson(part), material: matJson(SURFACES[surface]) },
        animationMappings: null, stateMachine: null, ragdoll: null,
      })),
    }), 'ValleyWindmill'))
  }
  const nodeJson = node(p.name, 'node', { id: id(`model:${p.key}:root`), children })
  const materialIds = [...new Set([...p.parts, ...(p.sails ?? [])].map(x => SURFACES[x.surface]))]
  const textureIds = [...new Set(materialIds.flatMap(m => texIdsOf(matJson(m))))]
  return { id: assetId, name: p.name, nodeJson, textureIds, materialIds, thumbnail: '' }
}
const propAssets = props.map(propModelAsset)

/** A placed copy of a building: the asset's subtree, linked, with a convex collider over its body. */
function placedBuilding(b, asset) {
  const copy = clone(asset.nodeJson)
  let i = 0
  const rekey = (n) => { n.id = id(`placed:${b.key}:${i++}`); (n.children ?? []).forEach(rekey) }
  rekey(copy)
  copy.position = [b.x, Math.round(b.y * 1000) / 1000, b.z]
  copy.rotation = [0, Math.round(b.yaw * 180 / Math.PI * 1000) / 1000, 0]
  copy.variables = vars({ __modelId: asset.id })
  copy.body = {
    ...souls.staticBody('box'),
    shapes: [convexShape(ROOT, b.prop.parts.map(x => x.part))],
  }
  return copy
}

// =====================================================================================================
// Foliage
// =====================================================================================================

const grassPatches = buildGrassPatches(path.join(BUILD, 'foliage', 'grass_medium_01_1k.gltf', 'grass_medium_01_1k.gltf'))
const pine = buildPine(path.join(BUILD, 'foliage', 'realistic_pine.glb'))
log('foliage read', grassPatches.map(g => `${g.name} ${triangles([g.part])} tris ${boundsOf([g.part]).size.map(v => v.toFixed(2)).join('x')}`).join(', '),
  `pine ${triangles([pine.bark, pine.needles])} tris ${boundsOf([pine.bark, pine.needles]).size.map(v => v.toFixed(1)).join('x')} m`)

const FOLIAGE_PROTOS = [
  ...grassPatches.map(g => ({
    key: `grass-${g.key}`, name: g.name, ...grassLevels(ROOT, g, GRASS_MAT), cull: GRASS_CULL,
    rule: { density: 0.4, minScale: 0.8, maxScale: 1.25, castShadows: false, collision: null }, cellSize: 13,
  })),
  {
    key: 'pine', name: 'Pine', ...pineLevels(ROOT, pine, BARK_MAT, NEEDLES_MAT), cull: PINE_CULL,
    rule: { density: 0.004, minScale: 0.55, maxScale: 0.95, castShadows: true, collision: { shape: 'cylinder', radius: 0.4, height: 8 } },
    cellSize: 40,
  },
]
log('foliage LODs', FOLIAGE_PROTOS.map(f => `${f.name} ${f.levels.map(l => triangles(l.map(x => x.part))).join('/')}`).join(', '))

const foliageAssets = FOLIAGE_PROTOS.map(f => modelAsset({
  id: id(`model:${f.key}`), idOf: id, name: f.name, levels: f.levels, distances: f.distances,
  cullDistance: f.cull, materialJson: matJson, vars, node,
}))
const GRASS_NAMES = grassPatches.map(g => g.name)
const RULES = FOLIAGE_PROTOS.map((f, i) => ({
  kind: 'mesh', id: id(`rule:${f.key}`), name: f.name, modelId: foliageAssets[i].id,
  density: f.rule.density, densityUnit: 'm2', minScale: f.rule.minScale, maxScale: f.rule.maxScale,
  cullDistance: f.cull, billboard: null, castShadows: f.rule.castShadows, collision: f.rule.collision,
}))

const terrainMaterial = valleyTerrainMaterial(TERRAIN_TEX, RULES, GRASS_NAMES)
const TERRAIN_MATERIAL_ID = id('terrain-material')

// ----- where things may grow -------------------------------------------------------------------------

const cliffDistance = cliffDistanceField(heights)
log('cliff distance field')
const keepClear = [
  ...buildings.map(b => ({ x: b.x, z: b.z, r: b.radius + 1.5 })),
  { x: BONFIRE.x, z: BONFIRE.z, r: 4 },
  { x: SPAWN.x, z: SPAWN.z, r: 3 },
  { x: POND.x, z: POND.z, r: POND.r + 1.5 },
]
const clear = (x, z, pad = 0) => keepClear.every(c => Math.hypot(x - c.x, z - c.z) > c.r + pad)
const inPlaza = (x, z) => z < -112 && Math.abs(x) < 16
const inValley = (x, z) => heights.heightAt(x, z) < 25 && Math.hypot(x, z) < 200 && cliffDistance(x, z) > 2

function scatter() {
  const layers = []
  const counts = {}
  // Grass: three patches sharing the valley floor at random, at the same overall density.
  {
    const random = rng(0x6a55)
    const allowed = GRASS_NAMES.map(n => onGround(math, terrainMaterial, mask, heights, n))
    const per = GRASS_NAMES.map(() => [])
    const total = FOLIAGE_PROTOS.slice(0, 3).reduce((s, f) => s + f.rule.density, 0)
    jitteredCandidates(random, { minX: -200, maxX: 200, minZ: -200, maxZ: 200 }, total, (x, z, r) => {
      if (!inValley(x, z) || inPlaza(x, z) || !clear(x, z) || heights.slopeAt(x, z) > 30) return false
      const k = Math.floor(r() * GRASS_NAMES.length)
      if (!allowed[k](x, z)) return false
      per[k].push([x, z])
      return true
    })
    per.forEach((pts, k) => { counts[GRASS_NAMES[k]] = pts.length; layers.push({ proto: FOLIAGE_PROTOS[k], points: pts, seed: 0x6a60 + k, sink: 0.02 }) })
  }
  // Pines: a dense belt at the cliff foot, a few stands in the valley, and sparse forest beyond the rim.
  {
    const random = rng(0x914e)
    const allowed = onGround(math, terrainMaterial, mask, heights, 'Pine')
    const roadsClear = (x, z, d) => roadDistance(x, z) > d
    const belt = jitteredCandidates(random, { minX: -280, maxX: 280, minZ: -280, maxZ: 280 }, 0.02, (x, z) => {
      const d = cliffDistance(x, z)
      return d >= 8 && d <= 30 && heights.heightAt(x, z) < 45 && heights.slopeAt(x, z) < 32
        && Math.hypot(x, z) < rimRadius(x, z) + 60 && clear(x, z, 6) && !inPlaza(x, z) && roadsClear(x, z, 6) && allowed(x, z)
    })
    const stands = jitteredCandidates(random, { minX: -160, maxX: 160, minZ: -160, maxZ: 160 }, 0.0025, (x, z) =>
      inValley(x, z) && cliffDistance(x, z) > 30 && clear(x, z, 12) && roadsClear(x, z, 9) && !inPlaza(x, z)
        && Math.hypot(x - SPAWN.x, z - SPAWN.z) > 18 && allowed(x, z))
    const beyond = jitteredCandidates(random, { minX: -650, maxX: 650, minZ: -650, maxZ: 650 }, 0.0014, (x, z) => {
      const h = heights.heightAt(x, z)
      return h > 55 && h < 210 && cliffDistance(x, z) > 6 && heights.slopeAt(x, z) < 28 && allowed(x, z)
    })
    const pts = [...belt, ...stands, ...beyond]
    counts.Pine = `${pts.length} (belt ${belt.length}, valley ${stands.length}, beyond ${beyond.length})`
    layers.push({ proto: FOLIAGE_PROTOS[3], points: pts, seed: 0x9150, sink: 0.25 })
  }
  log('scatter', JSON.stringify(counts))
  return layers.map(({ proto, points, seed, sink }) => {
    const random = rng(seed)
    const i = FOLIAGE_PROTOS.indexOf(proto)
    const [base, ...lods] = layerModels(proto.levels, matJson)
    return {
      kind: 'mesh', name: proto.name, key: RULES[i].id, textureId: null,
      params: { density: proto.rule.density, minScale: proto.rule.minScale, maxScale: proto.rule.maxScale },
      densityUnit: 'm2',
      ...(proto.rule.collision ? { collision: proto.rule.collision } : {}),
      model: base[0],
      ...(base.length > 1 ? { models: base } : {}),
      lods: lods.map((models, k) => ({ models, distance: proto.distances[k] })),
      cullDistance: proto.cull,
      ...(proto.rule.castShadows ? { castShadows: true } : {}),
      cellSize: proto.cellSize,
      instances: instancesBlob(points, heights, random, proto.rule.minScale, proto.rule.maxScale, sink),
    }
  })
}
const foliageLayers = scatter()
{
  let deepest = 0
  for (let z = -POND.r; z <= POND.r; z += 0.5) for (let x = -POND.r; x <= POND.r; x += 0.5)
    deepest = Math.max(deepest, POND_LEVEL - heights.heightAt(POND.x + x, POND.z + z))
  log(`pond water level ${POND_LEVEL} m, deepest ${deepest.toFixed(2)} m, floor ${POND_FLOOR.toFixed(2)} m, reach ${POND_REACH.toFixed(2)} m`)
}

// =====================================================================================================
// The scene
// =====================================================================================================

const at = (x, z, lift = 0.05) => [x, Math.round((heights.heightAt(x, z) + lift) * 1000) / 1000, z]

/** Euler degrees [pitch, yaw, 0] whose forward (+Z, Rz·Ry·Rx) is `dir`. */
function eulerToward(dir) {
  const l = Math.hypot(...dir)
  const [x, y, z] = dir.map(v => v / l)
  const pitch = Math.asin(-y) * 180 / Math.PI
  const yaw = Math.atan2(x, z) * 180 / Math.PI
  return [Math.round(pitch * 100) / 100, Math.round(yaw * 100) / 100, 0]
}

/** The player's camera sees the far mountains: the Playable's 100 m far plane is a room's. */
const CAMERA_FAR = 3000
function widenCamera(json) {
  const walk = (n) => { if (n.type === 'camera' && n.camera) n.camera.far = CAMERA_FAR; (n.children ?? []).forEach(walk) }
  walk(json)
}
// The template, its recorded source (what copies are checked against), and the placed copy all agree.
widenCamera(LEVEL.player.nodeJson)
widenCamera(souls.TEMPLATE_SOURCE.get(LEVEL.player.id))

function landscapeNode() {
  const blob = heights.serialize()
  return node('Landscape', 'landscape', {
    id: id('landscape'),
    terrain: {
      size: TERRAIN.size, resolution: TERRAIN.resolution, chunkQuads: TERRAIN.chunkQuads,
      ...blob,
      layerStack: {
        layerFormat: 2,
        base: { materialId: TERRAIN_MATERIAL_ID, material: terrainMaterial },
        paintLayers: [],
        slotChannels: { [TRAIL_SLOT]: TRAIL_CHANNEL },
        maskRes: MASK_RES, maskSlices: 1,
        masks: Buffer.from(mask).toString('base64'),
      },
      foliage: foliageLayers,
      foliageColliders: { enabled: true, radius: 40, maxBodies: 256 },
    },
  })
}

function pondWater() {
  return node('Pond Water', 'model', {
    id: id('pond:water'), position: [POND.x, POND_LEVEL, POND.z],
    variables: vars({ __materialId: WATER_MAT }),
    model: { geometry: waterPlane(POND_HALF, 8), material: matJson(WATER_MAT) },
    animationMappings: null, stateMachine: null, ragdoll: null,
  })
}

/**
 * The pond's water, as physics sees it: a box from below the basin floor up to the water level. Every
 * dynamic body in it is buoyed by its mass against the water it displaces; it feeds the surface's
 * ripple uniforms (no splash particles: the rings are the whole effect). Characters are not buoyed (their capsules are mostly air).
 */
function pondVolume() {
  const floor = POND_FLOOR - 0.3
  const depth = POND_LEVEL - floor
  return node('Pond Water Volume', 'waterVolume', {
    id: id('pond:volume'),
    position: [POND.x, Math.round((floor + depth / 2) * 1000) / 1000, POND.z],
    waterVolume: {
      size: [2 * POND_HALF, Math.round(depth * 1000) / 1000, 2 * POND_HALF], density: 1000,
      linearDrag: 2.5, angularDrag: 1.5, waveAmplitude: 0.025, waveFrequency: 0.45, affectCharacters: false,
      surfaceNodeId: id('pond:water'), splashTemplate: '', enabled: true,
    },
  })
}

/**
 * Where wading slows you and stops rolls: the souls scripts read `isWater` / `waterSpeedScale` off the
 * trigger they enter, and `waterLevel` to count only feet that are actually under the water.
 */
function pondZone() {
  const height = Math.round((POND_LEVEL - POND_FLOOR + 2.5) * 1000) / 1000
  return node('Pond Zone', 'node', {
    id: id('pond:zone'), position: [POND.x, Math.round(POND_FLOOR * 1000) / 1000, POND.z],
    variables: vars({ isWater: true, waterSpeedScale: 0.55, waterLevel: POND_LEVEL }),
    trigger: { shapes: [{ type: 'cylinder', radius: Math.round((POND_REACH + 0.5) * 100) / 100, height, numSegments: 24,
                          offset: [0, height / 2, 0], rotation: [0, 0, 0] }] },
  })
}

/**
 * Things to float: primitive props with real masses, so buoyancy can tell them apart. Dropped a little
 * above the surface; each settles at the depth its mass displaces (the iron chest sinks).
 */
const FLOATERS = [
  // [key, name, shape, material, scale, mass, offset from the pond centre, rotation]
  ['crate', 'Floating Crate', 'box', 'wood', [0.8, 0.8, 0.8], 120, [-3, -2], [0, 25, 0]],
  ['log', 'Floating Log', 'cylinder', 'wood', [0.5, 2.4, 0.5], 280, [3, 2], [0, 40, 90]],
  ['barrel', 'Floating Barrel', 'cylinder', 'wood', [0.7, 0.9, 0.7], 150, [0, 4], [0, 0, 0]],
  ['chest', 'Iron Chest', 'box', 'metal', [0.6, 0.45, 0.45], 420, [2, -3], [0, -15, 0]],
]
function floaters() {
  return FLOATERS.map(([key, name, shape, mat, scale, mass, [dx, dz], rotation]) => {
    const lift = Math.max(...scale) / 2 + 0.3
    const n = souls.prop(`valley:floater:${key}`, name, shape, souls.MAT[mat], {
      position: [POND.x + dx, Math.round((POND_LEVEL + lift) * 1000) / 1000, POND.z + dz], scale, rotation, solid: true,
    })
    n.body = { ...n.body, mass, linearDamping: 0.05, angularDamping: 0.1, friction: 0.5 }
    return n
  })
}

/** What the water reflects: a probe over the pond, baked on load (a probe with no bake data bakes). */
function pondProbe() {
  const probe = souls.sourceNode('light probe')
  probe.name = 'Pond Probe'
  probe.id = id('pond:probe')
  probe.position = [POND.x, Math.round((POND_LEVEL + 4) * 1000) / 1000, POND.z]
  Object.assign(probe, { resolution: 128, mode: 'baked', intensity: 1, size: [44, 24, 44], blendDistance: 10 })
  return probe
}

function valleyScene() {
  const sun = souls.sourceNode('light')
  sun.name = 'Sun'
  sun.id = id('sun')
  sun.rotation = eulerToward(SUN_TRAVEL)
  sun.light = { unit: 'photometric', color: [1, 0.96, 0.9], intensity: 100000, angularRadius: 0.27 }
  sun.castShadows = true
  const sky = souls.sourceNode('sky atmosphere')
  sky.id = id('sky')
  Object.assign(sky.atmosphere, { fogStart: 250, fogDensity: 0.0005, fogHeight: 150, fogMaxOpacity: 0.55, godRayMaxDistance: 160 })
  const clouds = souls.sourceNode('volumetric clouds')
  clouds.id = id('clouds')

  const placedBuildings = buildings.map(b => placedBuilding(b, propAssets[props.indexOf(b.prop)]))

  const bonfire = souls.bonfireNode()
  bonfire.position = at(BONFIRE.x, BONFIRE.z, 0)
  bonfire.rotation = [0, 200, 0]

  const fog = souls.fogGateNode()
  // Across the mouth of the cliff notch; widened to its ~13 m (the body and the wall scale with the node).
  const fogZ = -117.5
  fog.position = at(0, fogZ, 0)
  fog.scale = [2.2, 1.25, 1]

  const lever = souls.leverNode()
  const gate = souls.shortcutGate()
  // The shortcut: a gate across the side path below the windmill hill, its lever on the hill side.
  gate.position = at(36, -29.5, 2)
  gate.rotation = [0, 56, 0]
  lever.position = at(40.5, -31, 0)
  lever.rotation = [0, -34, 0]

  const epilogue = souls.messageNode('epilogue', 'The Warden rests', 'The valley falls silent.\nThank you for playing.', at(2.5, -137, 0), 0)
  epilogue.name = 'Epilogue Message'
  epilogue.scriptVars.hiddenUntilRevealed = true

  const interactables = souls.group('interactables', 'Interactables', [
    linkInstance(LEVEL.bonfire, bonfire),
    souls.placedMessage('welcome', 'The Valley', 'Follow the road north, through the hamlet, to the gate in the cliffs.\nRest at the bonfire to level up and refill your Estus.\nLock on with Q / R3. Tap Space / B to roll.', at(-9.5, 79, 0), 180),
    souls.placedMessage('roll', 'Try rolling', 'Tap Space (B) to roll through an attack.\nHold it to sprint. Rolling costs stamina.', at(-16, 63, 0), 160),
    souls.placedMessage('lock', 'Lock on', 'Q (R3) holds the camera on a foe.\nZ / C or a flick of the stick switches targets.', at(-27, 22, 0), 200),
    souls.placedMessage('sorcerer', "Beware the sorcerer's light", 'Bolts fly true but slow.\nRoll toward them, not away.', at(-14, 3, 0), 120),
    souls.placedMessage('knight', 'A knight keeps the pond', 'Its overhead blow cannot be interrupted.\nA greatsword breaks its stance.', at(31, 12, 0), 240),
    souls.placedMessage('warden', 'The Hollow Warden', 'Beyond the fog waits the keeper of the gate.\nWhen it bleeds, it rages.', at(2.5, -108, 0), 180),
    linkInstance(LEVEL.message, epilogue),
    souls.placedPickup('souls-hamlet', 'Souls Pickup', at(-60, 36, 0), { kind: 'souls', amount: 300, itemName: 'Soul of a Lost Undead' }),
    souls.placedPickup('estus-shard', 'Estus Shard', at(WATCHTOWER.x + 6, WATCHTOWER.z + 5, 0), { kind: 'flaskShard', amount: 1, itemName: 'Estus Shard' }),
    souls.placedPickup('souls-pond', 'Pond Souls', at(POND.x + 4, POND.z - 13, 0), { kind: 'souls', amount: 800, itemName: 'Soul of a Nameless Soldier' }),
    souls.placedPickup('boss-reward', 'Boss Reward', at(0, -136, 0), { kind: 'souls', amount: 3000, itemName: 'Soul of the Hollow Warden', hiddenUntilRevealed: true }),
    linkInstance(LEVEL.lever, lever),
    linkInstance(LEVEL.gate, gate),
    linkInstance(LEVEL.fogGate, fog),
    // Walking into this starts the boss fight even without passing the fog: the plaza past the notch.
    node('Boss Arena', 'node', {
      id: id('zone:arena'), position: at(0, -130, 0),
      variables: vars({ isBossArena: true }),
      trigger: { shapes: [{ type: 'box', width: 2 * NOTCH_HALF_WIDTH + 6, height: 8, depth: 22, offset: [0, 4, 0], rotation: [0, 0, 0] }] },
    }),
  ])

  const spawns = souls.group('spawns', 'Enemy Spawns', [
    souls.placedSpawn('hollow-a', 'Spawn Hollow A', at(-24, 16), 20, { templateName: 'Hollow' }),
    souls.placedSpawn('hollow-b', 'Spawn Hollow B', at(-13, -12), 0, { templateName: 'Hollow' }),
    souls.placedSpawn('hollow-c', 'Spawn Hollow C', at(-7, -44), 10, { templateName: 'Hollow' }),
    souls.placedSpawn('hollow-d', 'Spawn Hollow D', at(-2, -82), 0, { templateName: 'Hollow' }),
    souls.placedSpawn('hollow-e', 'Spawn Hollow E', at(14, -15), 300, { templateName: 'Hollow' }),
    souls.placedSpawn('caster', 'Spawn Sorcerer', at(WATCHTOWER.x - 7, WATCHTOWER.z + 7), 230, { templateName: 'Hollow Sorcerer' }),
    souls.placedSpawn('knight', 'Spawn Elite Knight', at(POND.x - 6, POND.z - 9), 300, { templateName: 'Elite Knight' }),
    souls.placedSpawn('warden', 'Spawn Hollow Warden', at(0, -133), 0, { templateName: 'Hollow Warden', isBossSpawn: true }),
  ])

  // Braziers in all but name: torches standing on the ground either side of the fog, their bracket post
  // down to the dirt (the keep's hung on walls at 2.2 m; there are no walls here).
  const torches = souls.group('torches', 'Torches', [[-5.6, fogZ + 1.5], [5.6, fogZ + 1.5], [-4.5, -139], [4.5, -139]]
    .map(([x, z], i) => linkInstance(LEVEL.torch, souls.torchNode(`valley-torch:${i}`, at(x, z, 0.6)))))

  const player = souls.playerNode()
  widenCamera(player)
  player.position = at(SPAWN.x, SPAWN.z)
  player.rotation = [0, SPAWN.yawDeg, 0]

  // Bounded to the valley (the cliffs bound it anyway), so an editor bake stays inside the play area.
  const navMesh = node('Nav Mesh', 'navMesh', {
    id: id('navmesh'), position: [0, 20, -20], bake: {}, agentRadius: 0.45, size: [300, 80, 260],
  })

  const root = node('root', 'node', {
    id: id('root'),
    children: [
      withScript(node('GameManager', 'node', {
        id: soulsId('manager'), children: [souls.banner(), souls.soundsGroup('manager', souls.SOUNDS.manager, { music: souls.MUSIC_CUES })],
      }), 'SoulsGameManager'),
      linkInstance(LEVEL.player, player),
      sun, sky, clouds,
      landscapeNode(),
      souls.group('water', 'Water', [pondWater(), pondProbe(), pondVolume(), pondZone(), ...floaters()]),
      souls.group('buildings', 'Buildings', placedBuildings),
      torches,
      interactables,
      spawns,
      navMesh,
    ],
    ambientLight: [9000, 9500, 11000],
  })

  const config = clone(souls.sourceScene.config)
  Object.assign(config.render, {
    exposure: 2.2, autoExposureEnabled: false, motionBlurEnabled: false,
    foliageCullDistance: PINE_CULL, foliageCellSize: 13,
    terrainLodEnabled: true, terrainLodDistance1: 150, terrainLodDistance2: 400, terrainLodStep1: 2, terrainLodStep2: 4,
  })
  return { scene: root, textures: [], ui: { version: 1, elements: [] }, config, assetHashes: {}, assetHashVersion: ASSET_HASH_VERSION, savedAt: souls.CREATED_AT }
}

// =====================================================================================================
// Write
// =====================================================================================================

const KEEP_ONLY = ['Stone (placeholder)', 'Flagstones (placeholder)']
const excludeMaterials = souls.materials.filter(m => KEEP_ONLY.includes(m.name)).map(m => m.id)
const SHARED_PROPS = '/Props/Shared/Materials'

const foliageFolder = Object.fromEntries(foliageAssets.map(a => [a.name, `${FOLIAGE}/Models`]))
const buildingFolder = Object.fromEntries(propAssets.map(a => [a.name, `${BUILDINGS}/Models`]))
const materialFolder = MATERIAL_FOLDERS

const result = souls.writeProject({
  out: OUT, projectName: PROJECT_NAME, sceneId: SCENE_ID,
  buildScene: valleyScene,
  example: {
    name: PROJECT_NAME,
    description: 'Hollow Keep, outdoors: the same souls-like combat, bonfire, fog gate and boss on a 2 km mountain valley — landscape layers for ground, rock, snow and trails, meadow grass, pine forest and a thatched hamlet.',
    order: 3,
  },
  models: [...propAssets, ...foliageAssets],
  terrainMaterials: [{ id: TERRAIN_MATERIAL_ID, name: 'Valley Landscape', material: terrainMaterial, textureIds: [...new Set(Object.values(TERRAIN_TEX).flatMap(t => Object.values(t)))] }],
  folders: {
    scene: { [PROJECT_NAME]: '/Scenes' },
    model: { ...foliageFolder, ...buildingFolder },
    material: {
      ...materialFolder,
      'Dark Stone (placeholder)': SHARED_PROPS, 'Wood (placeholder)': SHARED_PROPS, 'Iron (placeholder)': SHARED_PROPS,
    },
    terrainMaterial: { 'Valley Landscape': LANDSCAPE },
    script: { 'Windmill Sails': `${BUILDINGS}/Scripts` },
  },
  textureEntries: TEXTURE_ENTRIES,
  refs: {
    modelIds: [souls.MANNEQUIN_MODEL, ...propAssets.map(a => a.id), ...foliageAssets.map(a => a.id)],
    terrainMaterialIds: [TERRAIN_MATERIAL_ID],
    foliageModelIds: foliageAssets.map(a => a.id),
  },
  excludeMaterials,
  hashKinds: [['terrainMaterial', 'terrainMaterials']],
})

const sceneFile = path.join(OUT, 'scenes', `${SCENE_ID}.json`)
log(`${PROJECT_NAME} written to editor/public/examples/valley/`)
log(`  templates ${result.templates} · materials ${result.materials} · textures ${result.textureCount} · scene ${mb(fs.statSync(sceneFile).size)} · TOTAL ${mb(result.total)}`)
log('Next:  npm --prefix editor run examples:list')
