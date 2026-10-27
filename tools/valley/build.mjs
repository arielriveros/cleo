#!/usr/bin/env node
// Authors the "Valley" example into editor/public/examples/valley/.
//
//     python tools/valley/prepare.py                         # once: textures -> build/valley_prepared/
//     node --max-old-space-size=12288 tools/valley/build.mjs
//     npm --prefix editor run examples:list                  # regenerates the gallery index
//
// The souls-like content, outdoors. Every playable element — the player, both weapons, the four
// enemy types, the Warden, the bonfire, the fog gate, the lever and gate, messages, pickups, the HUD — is
// the souls demo's own, imported from tools/soulsDemo/build.mjs and linked to the same templates. What is
// new is the level: a 2 km landscape from build/valley_height_4097_16bit.png with a four-surface landscape
// material (ground, rock, snow, and painted trails along the roads), pre-scattered meadow grass and pines,
// and four FBX buildings on the pads the heightmap was flattened for.
//
// Positions come from the map's technical reference (layout.mjs); every height is sampled from the
// heightmap (heights.mjs). The source art is in build/, which is gitignored: this is run by hand and its
// OUTPUT is committed.

import fs from 'fs'
import { spawnSync } from 'child_process'
import path from 'path'
import { node, vars, loadScriptReflector, mb } from '../exampleKit/bundle.mjs'
import { packFormat2 } from '../exampleKit/packFormat2.mjs'
import { ASSET_HASH_VERSION } from '../exampleKit/editorConstants.mjs'
import * as souls from '../soulsDemo/build.mjs'
import { loadHeights } from './heights.mjs'
import {
  GATE_PLAZA, HAMLET, NOTCH_HALF_WIDTH, POND, ROADS, SPAWN, SUN_TRAVEL, TERRAIN, WATCHTOWER,
  catmullRom, distanceToPolyline, rimRadius,
} from './layout.mjs'
import {
  MASK_RES, ROCKY_DIRT_SLOT, SLOT_CHANNELS, TRAIL_CHANNEL, TRAIL_SLOT, loadLayerMath, paintForestFloor, sampleMask, surfaceWeights,
  trailMask, valleyTerrainMaterial,
} from './landscape.mjs'
import {
  FLOWER_CULL, GRASS_CULL, PINE_BILLBOARD, PINE_CULL, ROCK_CULL, buildFlowerPatches, buildGrassPatches, buildMossRocks, buildPine,
  cliffDistanceField, flowerLevels, grassLevels, instancesBlob, jitteredCandidates, layerModels, modelAsset, onGround, onSurface,
  pineLevels, rng, rockLevels, triangles,
} from './foliage.mjs'
import { buildProps } from './props.mjs'
import { WATER_SOURCE, WATER_UNIFORMS } from './water.mjs'
import { boundsOf, convexShape, geometryJson, partsOf, readGltf } from './meshes.mjs'
import { buildBarrel, buildSkullCave } from './setPieces.mjs'
import { buildCampfire, buildStandingTorch, buildWallTorch, rayHit } from './torches.mjs'
import { buildCage, buildCandle } from './dungeon/props.mjs'
import { buildDungeon } from './dungeon/scene.mjs'

const { ROOT, stableId: soulsId, clone, matJson, material, textures, LEVEL, linkInstance, withScript } = souls
const BUILD = path.join(ROOT, 'build')
const PREPARED = path.join(BUILD, 'valley_prepared')
const OUT = path.join(ROOT, 'editor', 'public', 'examples', 'valley')
const PROJECT_NAME = 'Valley'
/** Lux on a surface that renders white at exposure 1 (src/graphics/lighting.ts). */
const REFERENCE_ILLUMINANCE = 78643.2

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
  // A bare name is a prepared texture; an absolute path is shipped as it is (already a 1k JPEG).
  const source = path.isAbsolute(file) ? file : path.join(PREPARED, file)
  textures.add(texId, source, { wrapping: 'repeat', mipMap: true }, ext === 'jpg' ? 'image/jpeg' : 'image/png')
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
  forest: groundTex('forest', 'Forest Floor'), rockydirt: groundTex('rockydirt', 'Rocky Dirt'),
}

/** A PBR material in Material.serialize()'s shape, with only the slots that are given. */
function pbrMaterial({ diff, nor, arm, rough, mask, side = 'front', roughness = 1, castShadow = true, tint = [1, 1, 1], wind, ...extra }) {
  return {
    type: 'pbr', baseColor: tint, metallic: 0, roughness, reflectance: 0.5, opacity: 1,
    // Material.parse reads windStrength/windStiffness/windRole/windFlutter off the top level.
    ...(wind ?? {}),
    ...(mask ? { alphaCutoff: 0.5 } : {}),
    emissiveFactor: [0, 0, 0], emissiveIntensity: 1,
    textures: {
      baseColorTexture: diff,
      ...(arm ? { metallicRoughnessTexture: arm, occlusionMap: arm } : {}),
      ...(rough ? { roughnessMap: rough } : {}),
      normalMap: nor,
      ...(mask ? { mask } : {}),
    },
    ...extra,
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
  // Soft meadow grass: a fifth of its height at full gust, little stiffness.
  wind: { windStrength: 0.2, windStiffness: 0.6 },
}))
const BARK_MAT = libraryMaterial('pine-bark', 'Pine Bark', `${FOLIAGE}/Materials`, pbrMaterial({
  diff: tex('pine_bark_diff.jpg', `${FOLIAGE}/Textures`, 'Pine Bark Base Color'),
  nor: tex('pine_bark_nor.png', `${FOLIAGE}/Textures`, 'Pine Bark Normal'),
  roughness: 0.85, side: 'double',
  // A pine layer bends as one plant (the strongest of its materials), so bark and needles share the lean.
  wind: { windStrength: 0.025, windStiffness: 2.2 },
}))
const NEEDLES_MAT = libraryMaterial('pine-needles', 'Pine Needles', `${FOLIAGE}/Materials`, pbrMaterial({
  diff: tex('pine_needles_diff.jpg', `${FOLIAGE}/Textures`, 'Pine Needles Base Color'),
  nor: tex('pine_needles_nor.png', `${FOLIAGE}/Textures`, 'Pine Needles Normal'),
  mask: tex('pine_needles_mask.png', `${FOLIAGE}/Textures`, 'Pine Needles Mask'),
  roughness: 0.75, side: 'double',
  // The needles add their own sprig sway and flutter on top of the trunk's sway.
  wind: { windStrength: 0.025, windStiffness: 2.2, windRole: 'leaves', windFlutter: 0.45 },
}))

const CELANDINE_SRC = path.join(BUILD, 'foliage', 'celandine_01_1k.gltf')
const CELANDINE_MAT = libraryMaterial('celandine', 'Celandine', `${FOLIAGE}/Materials`, pbrMaterial({
  diff: tex(path.join(CELANDINE_SRC, 'textures', 'celandine_01_diff_1k.jpg'), `${FOLIAGE}/Textures`, 'Celandine Base Color'),
  nor: tex(path.join(CELANDINE_SRC, 'textures', 'celandine_01_nor_gl_1k.jpg'), `${FOLIAGE}/Textures`, 'Celandine Normal'),
  arm: tex(path.join(CELANDINE_SRC, 'textures', 'celandine_01_arm_1k.jpg'), `${FOLIAGE}/Textures`, 'Celandine ARM'),
  side: 'double', castShadow: false,
  // Modelled petals, no cutout: the flowers bend like the grass they grow in.
  wind: { windStrength: 0.2, windStiffness: 0.6 },
}))
const MOSS_SRC = path.join(BUILD, 'foliage', 'rock_moss_set_02_1k.gltf')
const MOSS_ROCK_MAT = libraryMaterial('moss-rock', 'Moss Rock', `${FOLIAGE}/Materials`, pbrMaterial({
  diff: tex(path.join(MOSS_SRC, 'textures', 'rock_moss_set_02_diff_1k.jpg'), `${FOLIAGE}/Textures`, 'Moss Rock Base Color'),
  nor: tex(path.join(MOSS_SRC, 'textures', 'rock_moss_set_02_nor_gl_1k.jpg'), `${FOLIAGE}/Textures`, 'Moss Rock Normal'),
  arm: tex('rock_moss_arm.jpg', `${FOLIAGE}/Textures`, 'Moss Rock ARM'),
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

// The valley's own scripts, beside the souls scripts in the same library: the windmill's sails, the
// fires' light, and the time of day.
const reflect = loadScriptReflector(ROOT)
for (const [file, name] of [['ValleyWindmill', 'Windmill Sails'], ['ValleyFireLight', 'Fire Light'], ['ValleyDayNight', 'Day and Night']]) {
  const source = fs.readFileSync(path.join(ROOT, 'examples', 'scripts', `${file}.ts`), 'utf8')
  const asset = { id: id(`script:${file}`), name, baseType: 'node', source, kind: 'class', variables: reflect(source) }
  souls.scripts.assets.push(asset)
  souls.scripts.byFile.set(file, asset)
}

// =====================================================================================================
// Fire: torches, the bonfire, fire pits, candles, hanging braziers
// =====================================================================================================
//
// Every fire here is the same three things: FLAMES, animated sprites playing build/fire.png (32 frames of
// a flame, 8 x 4 cells of 128 x 256); EMBERS rising off it and, now and then, a burst of SPARKS that fall
// and bounce across the floor; and a point LIGHT. A FireLight script on the root flickers the light, keeps
// the unlit flames at a sane brightness whatever the exposure (the valley's noon, its night, the dungeon),
// and lets the valley's Time of Day raise the light after dark.

const FIRE = '/Props/Fire'
const FIRE_TEXTURE = (() => {
  // Clamp-wrapped: the sheet is an atlas, and repeat would bleed the neighbouring frame in at every edge.
  const texId = id('texture:fire.png')
  textures.add(texId, path.join(BUILD, 'fire.png'), { wrapping: 'clamp', mipMap: true }, 'image/png')
  TEXTURE_ENTRIES.push({ folder: `${FIRE}/Textures`, name: 'Fire Animation', id: texId, ext: 'png' })
  return texId
})()
const FIRE_TILESET = {
  id: id('tileset:fire'), name: 'Fire', textureId: FIRE_TEXTURE,
  imageWidth: 1024, imageHeight: 1024, tileWidth: 128, tileHeight: 256,
  margin: 0, spacing: 0, columns: 8, rows: 4,
  // Over the bloom threshold: a flame should glow.
  overdrive: 2, tiles: {}, terrains: [], variantSets: [], textureIds: [FIRE_TEXTURE],
}
const FIRE_FRAMES = Array.from({ length: 32 }, (_, i) => i)

/**
 * How much the camera's exposure brightens the flames and embers (Sprite / ParticleSystemNode
 * exposureWeight). They are unlit: taken whole, the exposure the valley's night opens up to (three times its
 * noon's) turns every flame tuned for daylight into a white smear, and a darker scene's more so. A tenth of
 * it keeps them the same flame everywhere, glowing a little brighter in the dark, in the editor as in play.
 */
const FIRE_EXPOSURE_WEIGHT = 0.1

/**
 * A flame `height` tall standing on `base`: a cylindrical billboard (it turns to the camera about its
 * upright axis), additive, each copy starting on a frame of its own so a row of torches does not flicker
 * in step. A frame's flame fills its cell from the bottom edge, its white-hot root a tenth of the way up,
 * so the sprite is sunk by that much to sit the root on `base`.
 */
function flame(key, height, base = [0, 0, 0], name = 'Flame') {
  return node(name, 'animatedSprite', {
    id: id(`flame:${key}`), position: [base[0], base[1] + height * 0.4, base[2]], scale: [height / 2, height, 1],
    sprite: {
      constraints: 'cylindrical', tilesetId: FIRE_TILESET.id, tileset: FIRE_TILESET, tileIndex: 0,
      tint: [1, 1, 1], opacity: 1, transparent: true, side: 'double', wireframe: false, blend: 'additive',
      exposureWeight: FIRE_EXPOSURE_WEIGHT,
    },
    animation: { frames: FIRE_FRAMES, frameSource: 'node', fps: 24, loop: true, randomStart: true },
  })
}

/**
 * A fire's light: warm and photometric.
 *
 * Lumens are set for the dungeon, which is held at EV 15 like the valley's noon: the souls content (glyphs,
 * glows, bolts, sparks) is tuned for an exposure about that, and a truly dark one (EV 0-2, a real torch-lit
 * room) would blow every one of them out. So the fires are as bright as the sun is dim. The valley's Time
 * of Day scales them down by day, when a torch should not light anything, and back up at night.
 *
 * Nothing casts shadows. A shadow-casting point light renders everything in its range six times, again
 * every frame something moves near it, and the player is always near the bonfire.
 */
function fireLight(key, lumens, range, position, castShadows = false) {
  return node('Light', 'light', {
    id: id(`fire-light:${key}`), position, lightType: 'point', castShadows,
    light: { unit: 'photometric', color: [1, 0.58, 0.28], intensity: lumens, range, sourceRadius: 0.08, legacyFalloff: false },
  })
}

const sparkFade = {
  color: [{ t: 0, c: [1, 0.9, 0.6] }, { t: 0.35, c: [1, 0.55, 0.15] }, { t: 1, c: [0.6, 0.1, 0.02] }],
  alpha: [{ t: 0, a: 1 }, { t: 0.75, a: 0.9 }, { t: 1, a: 0 }],
}
const emberFade = {
  color: [{ t: 0, c: [1, 0.8, 0.45] }, { t: 0.4, c: [1, 0.45, 0.1] }, { t: 1, c: [0.5, 0.08, 0.02] }],
  alpha: [{ t: 0, a: 0 }, { t: 0.08, a: 1 }, { t: 0.7, a: 0.8 }, { t: 1, a: 0 }],
}
/**
 * Embers, always rising off the flame; and sparks, NOW AND THEN: a burst is rolled every `interval` seconds
 * and comes up `chance` of the time, so it never falls on a beat (and each copy rolls its own: the engine
 * salts an effect's seed per node). Sparks fall under gravity and bounce off the colliders round the fire
 * (the dungeon's floor boxes, a building's hull) and scene depth, losing a little life at each bounce.
 */
function emberEmitters(key, { rate, radius, interval, chance, count, speed }) {
  return [
    souls.emitter(`valley:${key}-embers`, 'Embers', {
      capacity: 128,
      spawn: [souls.mod('spawnRate', { rate })],
      init: [souls.mod('shape', { shape: 'sphere', radius, thickness: 1 }), souls.mod('lifetime', { range: [1.2, 2.8] }),
        souls.mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 25, speed: [0.35, 0.9] }), souls.mod('size', { range: [0.012, 0.026] }),
        souls.mod('color', { mode: 'constant', colorA: [1, 0.6, 0.2, 1], intensity: 8 })],
      update: [souls.mod('curlNoise', { strength: 0.9, frequency: 1.3, scroll: 0.4 }), souls.mod('drag', { coefficient: 0.5 }),
        souls.mod('colorOverLife', { gradient: emberFade })],
      render: { blend: 'additive', softness: 0 },
    }),
    souls.emitter(`valley:${key}-sparks`, 'Sparks', {
      capacity: 64, maxLod: 1,
      spawn: [souls.mod('spawnRate', { rate: 0 }), souls.mod('spawnBurst', { bursts: [{ time: 0.3, count, cycles: 0, interval, probability: chance }] })],
      init: [souls.mod('shape', { shape: 'sphere', radius: radius * 0.6, thickness: 1 }), souls.mod('lifetime', { range: [1.4, 2.6] }),
        souls.mod('velocity', { mode: 'direction', direction: [0, 1, 0], spread: 65, speed }), souls.mod('size', { range: [0.01, 0.022] }),
        souls.mod('color', { mode: 'constant', colorA: [1, 0.75, 0.35, 1], intensity: 14 })],
      update: [souls.mod('gravity', { scale: 1 }), souls.mod('drag', { coefficient: 0.25 }),
        // Off scene depth: the floor where they land is on screen whenever they are. Colliding with the
        // physics bodies too would pack the colliders round every torch, every frame.
        souls.mod('collision', { bodies: false, depth: true, radius: 1, restitution: 0.45, friction: 0.35, lifetimeLoss: 0.12, kill: false }),
        souls.mod('colorOverLife', { gradient: sparkFade })],
      render: { blend: 'additive', alignment: 'velocity', stretch: 0.7, softness: 0 },
    }),
  ]
}
const fxLod = (near, far, cull) => ({
  enabled: true, cullDistance: cull, scaleBursts: false,
  levels: [{ distance: near, spawnScale: 0.6, stepScale: 2 }, { distance: far, spawnScale: 0.3, stepScale: 3 }],
})
// Bounds reach down to the floor under the flame: that is where the sparks end up.
const TORCH_FX = souls.vfx('valley:torch-embers', 'Torch Embers',
  emberEmitters('torch', { rate: 6, radius: 0.06, interval: 1.3, chance: 0.12, count: 7, speed: [1.2, 3] }),
  { center: [0, -1.1, 0], extents: [1.8, 1.9, 1.8] }, fxLod(8, 16, 26))
const HEARTH_FX = souls.vfx('valley:hearth-embers', 'Hearth Embers',
  emberEmitters('hearth', { rate: 16, radius: 0.3, interval: 0.8, chance: 0.3, count: 12, speed: [1.6, 3.6] }),
  { center: [0, 0.8, 0], extents: [2.6, 2.4, 2.6] }, fxLod(12, 24, 45))
const fx = (key, asset, position) => {
  const n = souls.particles(`valley:${key}`, 'Embers', asset, { position })
  n.particleSystem.exposureWeight = FIRE_EXPOSURE_WEIGHT
  return n
}

// ----- materials ---------------------------------------------------------------------------------------

const fireMaterial = (key, name, prefix, extra = {}) => libraryMaterial(key, name, `${FIRE}/Materials`, pbrMaterial({
  diff: tex(`${prefix}_diff.jpg`, `${FIRE}/Textures`, `${name} Base Color`),
  nor: tex(`${prefix}_nor.png`, `${FIRE}/Textures`, `${name} Normal`),
  arm: tex(`${prefix}_arm.jpg`, `${FIRE}/Textures`, `${name} ARM`),
  ...extra,
}))
const WALL_TORCH_MAT = fireMaterial('wall-torch', 'Wall Torch', 'wall_torch')
const STANDING_TORCH_MAT = fireMaterial('standing-torch', 'Standing Torch', 'standing_torch')
// The campfire's three: the stone ring, the logs, and the charred bed under them.
const CAMPFIRE_MATS = ['Material_25', 'Material_26', 'Material_27'].map((m, i) =>
  fireMaterial(`campfire-${i}`, ['Campfire Stones', 'Campfire Logs', 'Campfire Embers'][i], `campfire_${m}`, { side: 'double' }))
const CANDLE_MAT = libraryMaterial('candle', 'Candle Wax', `${FIRE}/Materials`, souls.pbr([0.86, 0.8, 0.62], { roughness: 0.55, emissive: [1, 0.6, 0.25], emissiveIntensity: 0.15 }))
// Its metal/rough map is on a second uv set the parts do not carry: plain values stand in.
const CAGE_MAT = libraryMaterial('cage', 'Iron Cage', `${FIRE}/Materials`, pbrMaterial({
  diff: tex('cage_diff.jpg', `${FIRE}/Textures`, 'Iron Cage Base Color'), roughness: 0.55, metallic: 0.8, side: 'double',
}))

const PROPS = path.join(BUILD, 'props')
const standingTorch = buildStandingTorch(PROPS)
const wallTorch = await buildWallTorch(ROOT, PROPS)
const campfire = buildCampfire(PROPS)
const brazierCage = buildCage(PROPS, { height: 1.0 })
const candle = buildCandle(0.4)

const meshNodes = (key, parts, materialOf) => parts.map((part, i) => modelNode(`${key}:mesh:${i}`, i ? `Mesh ${i + 1}` : 'Mesh', part, materialOf(part, i)))
const above = (p, dy) => [p[0], p[1] + dy, p[2]]

// ----- the templates, each built by one builder for the template and for every placed copy ------------

function wallTorchNode(key, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const f = wallTorch.flame
  return withScript(node('Wall Torch', 'node', {
    id: id(`wall-torch:${key}`), position, rotation,
    children: [
      ...meshNodes(`wall-torch:${key}`, wallTorch.parts, () => WALL_TORCH_MAT),
      flame(`wall-torch:${key}`, 0.5, above(f, -0.06)),
      fx(`wall-torch:${key}:embers`, TORCH_FX, above(f, 0.1)),
      // Half a metre out in front of the flame: a light that close to the stone burns a white disc into it.
      fireLight(`wall-torch:${key}`, 850000, 7, [f[0], f[1] + 0.2, f[2] + 0.5]),
    ],
  }), 'ValleyFireLight')
}

function standingTorchNode(key, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
  const f = standingTorch.flame
  const n = withScript(node('Torch', 'node', {
    id: id(`torch:${key}`), position, rotation, scale,
    children: [
      ...meshNodes(`torch:${key}`, standingTorch.parts, () => STANDING_TORCH_MAT),
      flame(`torch:${key}`, 0.6, above(f, -0.08)),
      fx(`torch:${key}:embers`, TORCH_FX, above(f, 0.1)),
      fireLight(`torch:${key}`, 1000000, 7, above(f, 0.3)),
    ],
  }), 'ValleyFireLight')
  n.body = { ...souls.staticBody('cylinder'), shapes: [{ type: 'cylinder', radius: 0.12, height: f[1], numSegments: 8, offset: [0, f[1] / 2, 0], rotation: [0, 0, 0] }] }
  return n
}

/** The fire of a bonfire or fire pit: flames over the logs, embers and sparks, and its light, under one FireLight. */
function hearth(key, { height = 1.2, lumens = 1100000, range = 10, base = [0, 0.3, 0], name = 'Fire' } = {}) {
  return withScript(node(name, 'node', {
    id: id(`hearth:${key}`),
    children: [
      flame(`hearth:${key}:a`, height, base, 'Flame'),
      flame(`hearth:${key}:b`, height * 0.8, [base[0] + 0.18, base[1], base[2] - 0.12], 'Flame'),
      flame(`hearth:${key}:c`, height * 0.7, [base[0] - 0.16, base[1], base[2] + 0.1], 'Flame'),
      fx(`hearth:${key}:embers`, HEARTH_FX, base),
      fireLight(`hearth:${key}`, lumens, range, [base[0], base[1] + height * 0.75, base[2]]),
    ],
  }), 'ValleyFireLight')
}

/** The bonfire: the scanned campfire, its fire (lit on first use) and where the player gets up. */
function bonfireNode(key, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const n = withScript(node('Bonfire', 'node', {
    id: id(`bonfire:${key}`), position, rotation,
    children: [
      souls.group(`valley:bonfire:${key}:model`, 'Model', meshNodes(`bonfire:${key}`, campfire.parts, (p) => CAMPFIRE_MATS[p.material])),
      hearth(`bonfire:${key}`),
      node('RespawnPoint', 'node', { id: id(`bonfire:${key}:respawn`), position: [0, 0.05, -1.6] }),
    ],
    // The interaction zone, as the souls bonfire's (a trigger cylinder the player's capsule overlaps).
    trigger: { shapes: [{ type: 'cylinder', radius: 1.5, height: 3, numSegments: 16, offset: [0, 1, 0], rotation: [0, 0, 0] }] },
  }), 'SoulsBonfire')
  n.body = { ...souls.staticBody('cylinder'), shapes: [{ type: 'cylinder', radius: 0.75, height: 0.4, numSegments: 12, offset: [0, 0.2, 0], rotation: [0, 0, 0] }] }
  return n
}

/** A fire pit: the same campfire, always burning, no rest. */
function firePitNode(key, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const n = node('Fire Pit', 'node', {
    id: id(`fire-pit:${key}`), position, rotation,
    children: [
      souls.group(`valley:fire-pit:${key}:model`, 'Model', meshNodes(`fire-pit:${key}`, campfire.parts, (p) => CAMPFIRE_MATS[p.material])),
      hearth(`fire-pit:${key}`, { lumens: 1400000, range: 11 }),
    ],
  })
  n.body = { ...souls.staticBody('cylinder'), shapes: [{ type: 'cylinder', radius: 0.75, height: 0.4, numSegments: 12, offset: [0, 0.2, 0], rotation: [0, 0, 0] }] }
  return n
}

/** A fire laid in a fireplace: the flames, embers and light of a bonfire with no campfire under them. */
function hearthNode(key, position = [0, 0, 0]) {
  const n = hearth(`hearth-node:${key}`, { height: 1.0, lumens: 1600000, range: 11, base: [0, 0, 0], name: 'Hearth' })
  n.position = position
  return n
}

/** A tall candle on an iron dish: a small flame, a small light, no shadow (too many candles, too few maps). */
function candleNode(key, position = [0, 0, 0]) {
  return withScript(node('Candle', 'node', {
    id: id(`candle:${key}`), position,
    children: [
      ...meshNodes(`candle:${key}`, candle.parts, () => CANDLE_MAT),
      flame(`candle:${key}`, 0.13, [0, candle.flame - 0.01, 0]),
      fireLight(`candle:${key}`, 62000, 3, [0, candle.flame + 0.08, 0]),
    ],
  }), 'ValleyFireLight', { flicker: 0.12 })
}

/** An iron cage hung from the ceiling with a fire in it. */
function brazierNode(key, position = [0, 0, 0]) {
  return withScript(node('Hanging Brazier', 'node', {
    id: id(`brazier:${key}`), position,
    children: [
      ...meshNodes(`brazier:${key}`, brazierCage.parts, () => CAGE_MAT),
      flame(`brazier:${key}`, 0.55, [0, 0.12, 0]),
      fx(`brazier:${key}:embers`, TORCH_FX, [0, 0.3, 0]),
      fireLight(`brazier:${key}`, 1300000, 9, [0, 0.55, 0]),
    ],
  }), 'ValleyFireLight')
}

const FIRE_TEMPLATES = {
  wallTorch: souls.asTemplate('valley:wall-torch', wallTorchNode('template')),
  torch: souls.asTemplate('valley:standing-torch', standingTorchNode('template')),
  bonfire: souls.asTemplate('valley:bonfire', bonfireNode('template')),
  firePit: souls.asTemplate('valley:fire-pit', firePitNode('template')),
  candle: souls.asTemplate('valley:candle', candleNode('template')),
  hearth: souls.asTemplate('valley:hearth', hearthNode('template')),
  brazier: souls.asTemplate('valley:brazier', brazierNode('template')),
}
const FIRE_BUILDERS = { wallTorch: wallTorchNode, torch: standingTorchNode, bonfire: bonfireNode, firePit: firePitNode, candle: candleNode, brazier: brazierNode, hearth: hearthNode }
/** A placed fire: the builder's node, linked to its template. */
const placeFire = (kind, key, ...args) => linkInstance(FIRE_TEMPLATES[kind], FIRE_BUILDERS[kind](key, ...args))

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

// The engine presets the valley's look is made of (tools/valley/presets.ts), resolved through vite-node
// because the tables are TypeScript. Every effect below is one named preset; nothing is hand-tuned.
// Keep the sun readable against the terrain. Higher ambient lifted every shaded prop and made the
// valley look uniformly overcast even under the sunny cloud preset.
const VALLEY_AMBIENT = [7000, 7600, 9000]
const PRESETS = (() => {
  const ambientLux = 0.2126 * VALLEY_AMBIENT[0] + 0.7152 * VALLEY_AMBIENT[1] + 0.0722 * VALLEY_AMBIENT[2]
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite-node', '--config', 'vitest.config.ts', 'tools/valley/presets.ts'],
    { cwd: ROOT, input: JSON.stringify({ ambientLux }), encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 << 20 })
  if (res.status !== 0) throw new Error(`preset resolution failed:
${res.stderr}`)
  return JSON.parse(res.stdout.slice(res.stdout.indexOf('{')))
})()

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
const flowerPatches = buildFlowerPatches(path.join(CELANDINE_SRC, 'celandine_01_1k.gltf'))
const mossRocks = buildMossRocks(path.join(MOSS_SRC, 'rock_moss_set_02_1k.gltf'))
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
  // Celandine: yellow flower clumps through the meadow grass, culled with it.
  ...flowerPatches.map(f => ({
    key: `flower-${f.key}`, name: f.name, ...flowerLevels(ROOT, f, CELANDINE_MAT), cull: FLOWER_CULL,
    rule: { density: 0.04, minScale: 0.8, maxScale: 1.2, castShadows: false, collision: null }, cellSize: 13,
  })),
  // Moss rocks: owned by the Rocky Dirt surface (its `foliageInclude`), not by the ground.
  ...mossRocks.map(r => ({
    key: `moss-${r.key}`, name: r.name, ...rockLevels(ROOT, r, MOSS_ROCK_MAT), cull: ROCK_CULL, surface: ROCKY_DIRT_SLOT,
    // Bedded into the slope they lie on, not standing level on it.
    orientation: 'normal',
    rule: {
      density: 0.0035, minScale: 0.7, maxScale: 1.4, castShadows: true,
      collision: r.collide ? { shape: 'sphere', radius: 0.7, offsetY: 0.35 } : null,
    },
    cellSize: 24,
  })),
]
const protoOf = (key) => FOLIAGE_PROTOS.find(f => f.key === key)
log('foliage LODs', FOLIAGE_PROTOS.map(f => `${f.name} ${f.levels.map(l => triangles(l.map(x => x.part))).join('/')}`).join(', '))

const foliageAssets = FOLIAGE_PROTOS.map(f => modelAsset({
  id: id(`model:${f.key}`), idOf: id, name: f.name, levels: f.levels, distances: f.distances,
  cullDistance: f.cull, materialJson: matJson, vars, node,
}))

// The pine's OCTAHEDRAL impostor: 8 x 8 views over the hemisphere, unlit albedo plus model-space normals,
// baked offline by the engine's own baker (tools/valley/bakeOctahedral.ts runs src/terrain/octahedralBake.ts,
// the code behind the editor's "Bake impostor"). Lit by the scene like the mesh, and right from every side
// and from above, so it can take over far closer than the flat card it replaced. Registered under the
// editor's own ids for it, so a re-bake in the terrain material REPLACES these rather than adding more.
const IMPOSTOR_FRAMES = 8
const IMPOSTOR_FRAME_SIZE = 256
const IMPOSTOR_NORMAL_FRAME_SIZE = 128
const IMPOSTOR_SIZE = IMPOSTOR_FRAMES * IMPOSTOR_FRAME_SIZE
function bakeImpostor(asset, level, materials) {
  const dir = path.join(BUILD, 'valley_impostor')
  fs.mkdirSync(dir, { recursive: true })
  const raw = path.join(ROOT, 'tools', 'valley', 'rawimage.py')
  const python = (args) => {
    const res = spawnSync('python', [raw, ...args], { encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`rawimage ${args[0]} failed:\n${res.stderr}`)
    return res.stdout
  }
  const decoded = new Map()
  const decode = (file) => {
    if (!decoded.has(file)) {
      const out = path.join(dir, `${file}.rgba`)
      decoded.set(file, { file: out, ...JSON.parse(python(['decode', path.join(PREPARED, file), out])) })
    }
    return decoded.get(file)
  }
  const parts = level.map(({ name, part, materialId }, i) => {
    const write = (suffix, arr) => {
      const file = path.join(dir, `${asset.name}-${i}.${suffix}`)
      fs.writeFileSync(file, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
      return file
    }
    const m = materials[materialId]
    return {
      name,
      positions: write('pos', Float32Array.from(part.positions)),
      normals: write('nrm', Float32Array.from(part.normals)),
      uvs: write('uv', Float32Array.from(part.uvs)),
      indices: write('idx', Uint32Array.from(part.indices)),
      diffuse: decode(m.diffuse),
      mask: m.mask ? decode(m.mask) : null,
      // The needles' material cutoff, so the baked holes are the ones the mesh shows.
      cutoff: m.mask ? 0.5 : 0,
    }
  })
  const albedoRaw = path.join(dir, `${asset.name}_impostor.rgba`)
  const normalRaw = path.join(dir, `${asset.name}_impostorNormal.rgba`)
  const request = path.join(dir, `${asset.name}.json`)
  fs.writeFileSync(request, JSON.stringify({
    frames: IMPOSTOR_FRAMES, frameSize: IMPOSTOR_FRAME_SIZE, normalFrameSize: IMPOSTOR_NORMAL_FRAME_SIZE, supersample: 2,
    albedoOut: albedoRaw, normalOut: normalRaw, parts,
  }))
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite-node', '--config', 'vitest.config.ts', 'tools/valley/bakeOctahedral.ts', request],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20 })
  if (res.status !== 0) throw new Error(`impostor bake failed:\n${res.stderr}`)
  const report = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')).trim().split('\n').pop())
  const albedo = path.join(dir, `${asset.name}_impostor.png`)
  const normal = path.join(dir, `${asset.name}_impostorNormal.png`)
  python(['encode', albedoRaw, String(report.albedoSize), String(report.albedoSize), albedo])
  python(['encode', normalRaw, String(report.normalSize), String(report.normalSize), normal])
  // Clamp-wrapped (the default): repeat would blend the atlas's outer frames into its opposite edge.
  const texId = `${asset.id}__impostor`, normalId = `${asset.id}__impostorNormal`
  textures.add(texId, albedo, { mipMap: true }, 'image/png')
  textures.add(normalId, normal, { mipMap: true }, 'image/png')
  TEXTURE_ENTRIES.push({ folder: `${FOLIAGE}/Textures`, name: `${asset.name} Impostor`, id: texId, ext: 'png' })
  TEXTURE_ENTRIES.push({ folder: `${FOLIAGE}/Textures`, name: `${asset.name} Impostor Normals`, id: normalId, ext: 'png' })
  log('impostor', `${asset.name}: ${IMPOSTOR_FRAMES}x${IMPOSTOR_FRAMES} views, r ${report.info.radius.toFixed(1)} m, ` +
    `${Math.round(report.coverage * 100)}% covered, ${report.ms} ms`)
  return { textureId: texId, textures: { normal: normalId }, octahedral: report.info }
}
const PINE_INDEX = FOLIAGE_PROTOS.findIndex(f => f.key === 'pine')
const FLOWER_NAMES = flowerPatches.map(f => f.name)
// From the LAST mesh level, the one it takes over from: baked from the full tree it came out denser and
// darker than the sparse level beside it, and the hand-over at PINE_BILLBOARD showed as a pop.
const PINE_LEVELS = FOLIAGE_PROTOS[PINE_INDEX].levels
const PINE_IMPOSTOR = bakeImpostor(foliageAssets[PINE_INDEX], PINE_LEVELS[PINE_LEVELS.length - 1], {
  [BARK_MAT]: { diffuse: 'pine_bark_diff.jpg' },
  [NEEDLES_MAT]: { diffuse: 'pine_needles_diff.jpg', mask: 'pine_needles_mask.png' },
})
FOLIAGE_PROTOS[PINE_INDEX].billboard = { ...PINE_IMPOSTOR, distance: PINE_BILLBOARD }
const GRASS_NAMES = grassPatches.map(g => g.name)
const RULES = FOLIAGE_PROTOS.map((f, i) => ({
  kind: 'mesh', id: id(`rule:${f.key}`), name: f.name, modelId: foliageAssets[i].id,
  density: f.rule.density, densityUnit: 'm2', minScale: f.rule.minScale, maxScale: f.rule.maxScale,
  cullDistance: f.cull, billboard: f.billboard ?? null, ...(f.billboard ? { impostorSize: IMPOSTOR_SIZE } : {}),
  castShadows: f.rule.castShadows, collision: f.rule.collision,
  ...(f.orientation ? { orientation: f.orientation } : {}),
}))

// Ground rules on the Ground; the moss rocks on the Rocky Dirt that carries them.
const terrainMaterial = valleyTerrainMaterial(TERRAIN_TEX, RULES.filter((_, i) => !FOLIAGE_PROTOS[i].surface),
  [...GRASS_NAMES, ...FLOWER_NAMES], { rockFoliage: RULES.filter((_, i) => FOLIAGE_PROTOS[i].surface === ROCKY_DIRT_SLOT) })
/** Index of a slot's surface in `surfaceWeights` (0 is the ground). */
const surfaceIndex = (slotId) => 1 + terrainMaterial.slots.findIndex(s => s.id === slotId)
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
  // Pines FIRST: the forest floor is painted where they stand, and everything after reads that mask.
  // A dense belt at the cliff foot, a few stands in the valley, and sparse forest beyond the rim.
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
    layers.push({ proto: protoOf('pine'), points: pts, seed: 0x9150, sink: 0.25 })
    // The leaf litter under them: the Forest Floor surface's mask channel.
    paintForestFloor(mask, pts)
  }
  // Grass and celandine share the valley floor: one jittered grid, each candidate given to one patch.
  {
    const random = rng(0x6a55)
    const kinds = [...GRASS_NAMES, ...FLOWER_NAMES].map(name => FOLIAGE_PROTOS.find(f => f.name === name))
    const allowed = kinds.map(f => onGround(math, terrainMaterial, mask, heights, f.name))
    const per = kinds.map(() => [])
    const total = kinds.reduce((sum, f) => sum + f.rule.density, 0)
    jitteredCandidates(random, { minX: -200, maxX: 200, minZ: -200, maxZ: 200 }, total, (x, z, r) => {
      if (!inValley(x, z) || inPlaza(x, z) || !clear(x, z) || heights.slopeAt(x, z) > 30) return false
      // Weighted by each prototype's own density, so the flowers stay a sprinkle in the grass.
      let pick = r() * total, k = 0
      while (k < kinds.length - 1 && pick > kinds[k].rule.density) { pick -= kinds[k].rule.density; k++ }
      if (!allowed[k](x, z)) return false
      per[k].push([x, z])
      return true
    })
    per.forEach((pts, k) => {
      counts[kinds[k].name] = pts.length
      layers.push({ proto: kinds[k], points: pts, seed: 0x6a60 + k, sink: 0.02 })
    })
  }
  // Moss rocks on the Rocky Dirt: only where that surface clearly wins, as the engine places them.
  {
    const random = rng(0x2c0c)
    const rocks = FOLIAGE_PROTOS.filter(f => f.surface === ROCKY_DIRT_SLOT)
    const surface = surfaceIndex(ROCKY_DIRT_SLOT)
    const allowed = rocks.map(f => onSurface(math, terrainMaterial, mask, heights, f.name, surface))
    const per = rocks.map(() => [])
    const total = rocks.reduce((sum, f) => sum + f.rule.density, 0)
    jitteredCandidates(random, { minX: -260, maxX: 260, minZ: -260, maxZ: 260 }, total, (x, z, r) => {
      if (inPlaza(x, z) || !clear(x, z, 2) || roadDistance(x, z) < 4) return false
      const k = Math.floor(r() * rocks.length)
      if (!allowed[k](x, z)) return false
      per[k].push([x, z])
      return true
    })
    per.forEach((pts, k) => {
      counts[rocks[k].name] = pts.length
      layers.push({ proto: rocks[k], points: pts, seed: 0x2c10 + k, sink: 0.1 })
    })
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
      ...(proto.billboard ? { billboard: proto.billboard } : {}),
      ...(proto.orientation ? { orientation: proto.orientation } : {}),
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
/** The player camera's boom length: where the player stands from the lens, so where depth of field focuses. */
const PLAYER_ARM = (() => {
  let arm = null
  const walk = (n) => { if (n.type === 'cameraRig' && arm === null) arm = n.armLength; (n.children ?? []).forEach(walk) }
  walk(LEVEL.player.nodeJson)
  if (typeof arm !== 'number') throw new Error('the player template has no camera rig')
  return arm
})()

function widenCamera(json) {
  const walk = (n) => { if (n.type === 'camera' && n.camera) n.camera.far = CAMERA_FAR; (n.children ?? []).forEach(walk) }
  walk(json)
}
// The template, its recorded source (what copies are checked against), and the placed copy all agree.
widenCamera(LEVEL.player.nodeJson)
widenCamera(souls.TEMPLATE_SOURCE.get(LEVEL.player.id))

/** A model node over one part, its material linked by id (as a library model's nodes are). */
function modelNode(key, name, part, materialId, extra = {}) {
  return node(name, 'model', {
    id: id(key), variables: vars({ __materialId: materialId }),
    model: { geometry: geometryJson(part), material: matJson(materialId) },
    animationMappings: null, stateMachine: null, ragdoll: null, ...extra,
  })
}

// =====================================================================================================
// Breakable barrels
// =====================================================================================================
//
// `Breakable Barrel` stands where it is placed and shatters into `Barrel Debris` when the player hits
// it or rolls into it (SoulsBreakable); the debris tumbles with physics and dissolves away (SoulsDebris).

const BARREL_SRC = path.join(BUILD, 'props', 'wooden_barrels_01_1k.gltf')
const BARREL_DIR = souls.PROP('Breakable Barrel')
const barrelTex = (set, kind, label) =>
  tex(path.join(BARREL_SRC, 'textures', `wooden_barrels_01_${set}_${kind}_1k.jpg`), `${BARREL_DIR}/Textures`, label)
const BARREL_MAT = libraryMaterial('barrel', 'Barrel', `${BARREL_DIR}/Materials`, pbrMaterial({
  diff: barrelTex('barrel01', 'diff', 'Barrel Base Color'), nor: barrelTex('barrel01', 'nor_gl', 'Barrel Normal'),
  arm: barrelTex('barrel01', 'arm', 'Barrel ARM'),
}))
const BARREL_PIECES_MAT = libraryMaterial('barrel-pieces', 'Barrel Pieces', `${BARREL_DIR}/Materials`, pbrMaterial({
  diff: barrelTex('pieces', 'diff', 'Barrel Pieces Base Color'), nor: barrelTex('pieces', 'nor_gl', 'Barrel Pieces Normal'),
  arm: barrelTex('pieces', 'arm', 'Barrel Pieces ARM'), side: 'double',
}))
const barrel = buildBarrel(path.join(BARREL_SRC, 'wooden_barrels_01_1k.gltf'))
log('barrel', `${barrel.height.toFixed(2)} m tall, r ${barrel.radius.toFixed(2)}, ${barrel.pieces.length} pieces`)

function breakableBarrelNode(key, position = [0, 0, 0], yaw = 0) {
  const H = barrel.height, R = barrel.radius
  const n = withScript(node('Breakable Barrel', 'node', {
    id: id(`barrel:${key}`), position, rotation: [0, yaw, 0],
    // Walked on, not carved round: one hit and it is gone.
    variables: vars({ navObstacle: false }),
    children: [
      modelNode(`barrel:${key}:mesh`, 'Mesh', barrel.barrel, BARREL_MAT),
      souls.soundsGroup(`valley:barrel:${key}`, ['Break'], { spatial: true }),
    ],
  }), 'SoulsBreakable')
  n.body = { ...souls.staticBody('cylinder'), shapes: [{ type: 'cylinder', radius: R, height: H, numSegments: 12, offset: [0, H / 2, 0], rotation: [0, 0, 0] }] }
  // A little wider than the body: a roll is noticed before the body stops it.
  n.trigger = { shapes: [{ type: 'box', width: 2 * R + 1, height: H + 0.4, depth: 2 * R + 1, offset: [0, (H + 0.4) / 2, 0], rotation: [0, 0, 0] }] }
  return n
}

function barrelDebrisNode() {
  return withScript(node('Barrel Debris', 'node', {
    id: id('barrel-debris'),
    children: barrel.pieces.map((p, i) => modelNode(`barrel-debris:${i}`, p.name, p.part, BARREL_PIECES_MAT, { position: p.position })),
  }), 'SoulsDebris')
}

const BARREL_TEMPLATE = souls.asTemplate('valley:barrel', breakableBarrelNode('template'))
const DEBRIS_TEMPLATE = souls.asTemplate('valley:barrel-debris', barrelDebrisNode())

// =====================================================================================================
// The skull cave
// =====================================================================================================
//
// Where the boss's fog wall stood: a skull carved into the cliff notch, the arch through it dark.
// Interact in front of it asks to go in (the player's ConfirmDialog) and loads the Dungeon scene behind
// a loading screen (SoulsSceneDoor).

const CAVE_DIR = souls.PROP('Skull Cave')
const CAVE_MAT = libraryMaterial('skull-cave', 'Skull Cave', `${CAVE_DIR}/Materials`, pbrMaterial({
  diff: tex('skull_cave_diff.jpg', `${CAVE_DIR}/Textures`, 'Skull Cave Base Color'),
  nor: tex('skull_cave_nor.png', `${CAVE_DIR}/Textures`, 'Skull Cave Normal'),
  arm: tex('skull_cave_arm.jpg', `${CAVE_DIR}/Textures`, 'Skull Cave ARM'),
  side: 'double',
}))
const CAVE_DARK_MAT = libraryMaterial('cave-dark', 'Cave Darkness', `${CAVE_DIR}/Materials`, souls.pbr([0, 0, 0], { roughness: 1, castShadow: false }))
const CAVE_WIDTH = 14
const cave = buildSkullCave(ROOT, path.join(BUILD, 'props', 'skull_cave', 'source', 'model.glb'), { width: CAVE_WIDTH })
const caveBounds = boundsOf([cave])
log('skull cave', `${(cave.indices.length / 3) | 0} tris, ${caveBounds.size.map(v => v.toFixed(1)).join(' x ')} m`)

/** A flat card facing +Z, base on y = 0: what stops the eye at the back of the arch. */
function darknessCard(width, height) {
  const w = width / 2
  return {
    positions: [-w, 0, 0, w, 0, 0, w, height, 0, -w, height, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    tangents: [], bitangents: [], texCoords: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3],
  }
}

function caveEntranceNode(position = [0, 0, 0]) {
  const depth = caveBounds.size[2]
  const n = withScript(node('Skull Cave Entrance', 'node', {
    id: id('cave'), position,
    children: [
      modelNode('cave:mesh', 'Mesh', cave, CAVE_MAT),
      // The arch runs right through the skull: a dark card in it reads as a cave going down, not a gap.
      node('Darkness', 'model', {
        id: id('cave:dark'), variables: vars({ __materialId: CAVE_DARK_MAT }),
        model: { geometry: darknessCard(caveBounds.size[0] * 0.44, caveBounds.size[1] * 0.62), material: matJson(CAVE_DARK_MAT) },
        animationMappings: null, stateMachine: null, ragdoll: null,
      }),
    ],
  }), 'SoulsSceneDoor', {
    targetScene: 'Dungeon', prompt: 'Enter the skull cave', question: 'Enter the skull cave?',
    detail: 'Cold air breathes out of the dark.\nThe way back out waits just inside.', loadingTitle: 'The Skull Cave', frontOnly: true,
    exitTo: 'Way Out', arrivalDistance: 3.5,
  })
  n.body = { ...souls.staticBody('box'), shapes: [convexShape(ROOT, [cave])] }
  n.trigger = { shapes: [{ type: 'box', width: 7, height: 4, depth: 4, offset: [0, 2, depth / 2 + 1.5], rotation: [0, 0, 0] }] }
  return n
}
const CAVE_TEMPLATE = souls.asTemplate('valley:cave', caveEntranceNode())

/** Where the barrels stand: beside the hamlet's houses and by the bonfire, on level ground. */
function barrelSpots() {
  const out = []
  const random = rng(0xba22e1)
  for (const b of buildings) {
    let placed = 0
    for (let tries = 0; tries < 24 && placed < 3; tries++) {
      const a = random() * Math.PI * 2
      const r = b.radius + 1.2 + random() * 0.8
      const x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r
      if (heights.slopeAt(x, z) > 14 || roadDistance(x, z) < 3) continue
      if (buildings.some(o => Math.hypot(x - o.x, z - o.z) < o.radius + 0.8)) continue
      if (out.some(([px, pz]) => Math.hypot(x - px, z - pz) < 1.1)) continue
      out.push([x, z, Math.round(random() * 360)])
      placed++
    }
  }
  for (const [dx, dz] of [[3.2, 1.6], [3.8, 2.6], [-2.9, 2.4]]) out.push([BONFIRE.x + dx, BONFIRE.z + dz, Math.round(random() * 360)])
  return out
}

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
        slotChannels: SLOT_CHANNELS,
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
      size: [2 * POND_HALF, Math.round(depth * 1000) / 1000, 2 * POND_HALF],
      ...PRESETS.water, affectCharacters: false,
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

/** Lighting and reflections for the hamlet: its houses and their torches, re-captured as the day turns. */
function hamletProbe() {
  const probe = souls.sourceNode('light probe')
  probe.name = 'Hamlet Probe'
  probe.id = id('hamlet:probe')
  probe.position = at(HAMLET.x, HAMLET.z, 6)
  Object.assign(probe, { resolution: 128, mode: 'baked', intensity: 1, size: [64, 26, 64], blendDistance: 12 })
  return probe
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

/**
 * The navmesh, baked as the editor's Bake button would: the terrain inside the volume at a 2 m step (the
 * full 2049-sample landscape would be eight million triangles), the static colliders, and every pine
 * trunk and building carved out. Floaters (dynamic) and characters are left out.
 *
 * Not 4 m: the fog-gate notch is about 4 m wide, and a 4 m grid samples its cliff walls into the floor
 * as 50-degree slopes, cutting the boss plaza off from the rest of the valley.
 */
function bakeValleyNavMesh(root, navMesh) {
  const volume = { position: navMesh.position, size: navMesh.size }
  const STEP = 2
  const lo = [0, 2].map(a => Math.floor((volume.position[a] - volume.size[a] / 2) / STEP) * STEP)
  const hi = [0, 2].map(a => Math.ceil((volume.position[a] + volume.size[a] / 2) / STEP) * STEP)
  const terrain = []
  for (let z = lo[1]; z < hi[1]; z += STEP) for (let x = lo[0]; x < hi[0]; x += STEP) {
    const a = [x, heights.heightAt(x, z), z], b = [x, heights.heightAt(x, z + STEP), z + STEP]
    const c = [x + STEP, heights.heightAt(x + STEP, z + STEP), z + STEP], d = [x + STEP, heights.heightAt(x + STEP, z), z]
    // Wound as heightfieldSoup winds, so the normal points up: a -> c -> d and a -> b -> c.
    terrain.push(...a, ...c, ...d, ...a, ...b, ...c)
  }
  const soup = { positions: new Float32Array(terrain), indices: new Uint32Array(0) }

  const { gather, bakeInto, sources } = souls.navBaker
  const { surface, obstacles } = gather(root, { skip: n => souls.isMover(n) || n.body?.mass > 0 })
  const inside = (x, z, m) => Math.abs(x - volume.position[0]) < volume.size[0] / 2 + m && Math.abs(z - volume.position[2]) < volume.size[2] / 2 + m
  let trunks = 0
  for (const layer of foliageLayers) {
    if (!layer.collision) continue
    const bytes = Buffer.from(layer.instances, 'base64')
    const all = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const kept = []
    for (let i = 0; i + 4 < all.length; i += 5) if (inside(all[i], all[i + 2], 2)) kept.push(...all.subarray(i, i + 5))
    const carved = sources.foliageNavObstacles(kept, layer.collision)
    trunks += carved.length
    obstacles.push(...carved)
  }
  const baked = bakeInto(navMesh, { surface, soups: [soup], obstacles, volume })
  log('navmesh', `${baked.regions} regions from ${baked.triangles} triangles, ${baked.obstacles} obstacles (${trunks} trunks), ${baked.ms} ms, ${mb(baked.bytes)}`)
}

/** Where the valley's wind blows TOWARD: degrees counter-clockwise from +X (WindNode's convention). */
const WIND_DIRECTION = 25

const round3 = (v) => Math.round(v * 1000) / 1000

/**
 * The valley's lamps, for the night: standing torches down the road through the hamlet (alternating sides,
 * about every 12 m) and either side of the bonfire, and wall torches on the buildings, on the walls that
 * face the road. A building's wall is found by casting at its own mesh, at lamp height, from eight sides.
 */
function valleyLamps(cavePair) {
  const out = []
  const clearOf = (x, z) => buildings.every(b => Math.hypot(x - b.x, z - b.z) > b.radius + 1)
    && Math.hypot(x - BONFIRE.x, z - BONFIRE.z) > 4 && out.every(l => Math.hypot(x - l.at[0], z - l.at[2]) > 5)
  // Road torches: from where the main road enters the hamlet to where it leaves it.
  const main = roadLines[0]
  let run = 0, side = 1
  for (let i = 1; i < main.length; i++) {
    const [ax, az] = main[i - 1], [bx, bz] = main[i]
    const len = Math.hypot(bx - ax, bz - az) || 1
    run += len
    if (az > 66 || az < 6 || run < 12) continue
    const nx = -(bz - az) / len, nz = (bx - ax) / len
    const x = bx + nx * 3.6 * side, z = bz + nz * 3.6 * side
    if (heights.slopeAt(x, z) > 18 || !clearOf(x, z)) continue
    out.push({ kind: 'torch', at: at(x, z, 0), yaw: 0 })
    run = 0
    side = -side
  }
  for (const [dx, dz] of [[-2.6, -1.6], [2.4, -2.6]]) out.push({ kind: 'torch', at: at(BONFIRE.x + dx, BONFIRE.z + dz, 0), yaw: 0 })
  // Wall torches: per building, the wall hits at 2.3 m whose outward normal looks most toward the road.
  const nearestRoad = (x, z) => roadLines[0].reduce((best, p) => Math.hypot(p[0] - x, p[1] - z) < Math.hypot(best[0] - x, best[1] - z) ? p : best)
  for (const b of buildings) {
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw)
    // Ry(yaw): local +X goes to (cos, 0, -sin), local +Z to (sin, 0, cos).
    const toWorld = (p) => [b.x + p[0] * c + p[2] * s, b.y + p[1], b.z - p[0] * s + p[2] * c]
    const dirWorld = (n) => [n[0] * c + n[2] * s, n[1], -n[0] * s + n[2] * c]
    const parts = b.prop.parts.map(x => x.part)
    const hits = []
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * Math.PI * 2, r = b.radius + 3
      const hit = rayHit(parts, [Math.cos(a) * r, 2.3, Math.sin(a) * r], [0, 2.3, 0])
      if (!hit || Math.abs(hit.normal[1]) > 0.3) continue
      const p = toWorld(hit.point), n = dirWorld(hit.normal)
      const road = nearestRoad(p[0], p[2])
      const away = Math.hypot(road[0] - p[0], road[1] - p[2]) || 1
      hits.push({ p, n, score: (n[0] * (road[0] - p[0]) + n[2] * (road[1] - p[2])) / away })
    }
    hits.sort((u, v) => v.score - u.score)
    const chosen = []
    for (const h of hits) if (chosen.length < 2 && h.score > -0.2 && chosen.every(o => Math.hypot(o.p[0] - h.p[0], o.p[2] - h.p[2]) > 4)) chosen.push(h)
    for (const h of chosen) out.push({
      kind: 'wallTorch', at: [round3(h.p[0]), round3(h.p[1] - wallTorch.flame[1] + 0.3), round3(h.p[2])], yaw: Math.atan2(h.n[0], h.n[2]) * 180 / Math.PI,
    })
  }
  return [...cavePair.map(([x, z]) => ({ kind: 'torch', at: at(x, z, 0.6), yaw: 0 })), ...out]
}

function valleyScene() {
  const sun = souls.sourceNode('light')
  sun.name = 'Sun'
  sun.id = id('sun')
  sun.rotation = eulerToward(SUN_TRAVEL)
  // A morning sun (the Morning Sun light preset, brightened against the valley's ambient as the inspector
  // does), a hazy summer sky with its distance haze, scattered fair-weather clouds, a breeze.
  // A sun twice the disc of the real one: softer shadow edges, which a 4k cascade can afford. The Time of Day
  // script moves it, warms it at the horizon and hands over to the moon.
  sun.light = { unit: 'photometric', ...PRESETS.sun, angularRadius: PRESETS.sun.angularRadius * 2 }
  sun.castShadows = true
  const sky = souls.sourceNode('sky atmosphere')
  sky.id = id('sky')
  // The god rays have no preset; their reach is the valley's scale. The night: a bright, cool moon well up
  // the sky, more stars, a faint airglow. The moon's LIGHT is the Time of Day's (moonlightIntensity).
  sky.atmosphere = {
    ...sky.atmosphere, ...PRESETS.sky, godRayMaxDistance: 160,
    nightEnabled: true, starIntensity: 1.6, starDensity: 0.6, airglowIntensity: 0.8,
    moonEnabled: true, moonSize: 2.4, moonPhase: 1, moonOffsetYaw: 20, moonOffsetPitch: 22, moonColor: [0.74, 0.82, 1], moonIntensity: 1.3,
    moonlightIntensity: 0.02,
  }
  const clouds = souls.sourceNode('volumetric clouds')
  clouds.id = id('clouds')
  // The preset sets the look; the clouds follow the Wind node below (useSceneWind), so its wind direction is unused.
  clouds.clouds = { ...clouds.clouds, ...PRESETS.clouds, useSceneWind: true }
  // One wind for the whole valley: the grass and pines sway with it, and the clouds drift the same way.
  // The fade distances are the foliage's performance budget, not a look, so they stay the valley's.
  const wind = node('Wind', 'wind', {
    id: id('wind'),
    wind: { direction: WIND_DIRECTION, ...PRESETS.wind, fadeStart: 35, fadeEnd: 70 },
  })
  // Lights the valley with its own sky, and lets the clouds' shadows sweep across it. At night the flat
  // ambient falls to a few percent with the sun (nightAmbient), so the moon and the torches carry it.
  const skyLight = node('Sky Light', 'skyLight', { id: id('skylight'), skyLight: { cloudShadows: true, nightAmbient: 0.025 } })
  const timeOfDay = withScript(node('Time of Day', 'node', { id: id('time-of-day') }), 'ValleyDayNight')

  const placedBuildings = buildings.map(b => placedBuilding(b, propAssets[props.indexOf(b.prop)]))

  const bonfire = placeFire('bonfire', 'valley', at(BONFIRE.x, BONFIRE.z, 0), [0, 200, 0])

  // The skull cave fills the cliff notch where the boss's fog wall used to stand: its face on the notch
  // line, the rest of it reaching back over the plaza.
  const notchZ = -117.5
  const caveCentreZ = notchZ - caveBounds.size[2] / 2
  const caveEntrance = linkInstance(CAVE_TEMPLATE, caveEntranceNode(at(0, caveCentreZ, -0.4)))

  const lever = souls.leverNode()
  const gate = souls.shortcutGate()
  // The shortcut: a gate across the side path below the windmill hill, its lever on the hill side.
  gate.position = at(36, -29.5, 2)
  gate.rotation = [0, 56, 0]
  lever.position = at(40.5, -31, 0)
  lever.rotation = [0, -34, 0]


  const interactables = souls.group('interactables', 'Interactables', [
    bonfire,
    souls.placedMessage('welcome', 'The Valley', 'Follow the road north, through the hamlet, to the skull in the cliffs.\nRest at the bonfire to level up and refill your Estus.\nLock on with Q / R3. Tap Space / B to roll.', at(-9.5, 79, 0), 180),
    souls.placedMessage('roll', 'Try rolling', 'Tap Space (B) to roll through an attack.\nHold it to sprint. Rolling costs stamina.', at(-16, 63, 0), 160),
    souls.placedMessage('lock', 'Lock on', 'Q (R3) holds the camera on a foe.\nZ / C or a flick of the stick switches targets.', at(-27, 22, 0), 200),
    souls.placedMessage('sorcerer', "Beware the sorcerer's light", 'Bolts fly true but slow.\nRoll toward them, not away.', at(-14, 3, 0), 120),
    souls.placedMessage('knight', 'A knight keeps the pond', 'Its overhead blow cannot be interrupted.\nA greatsword breaks its stance.', at(31, 12, 0), 240),
    souls.placedMessage('warden', 'The Skull Cave', 'A mouth in the cliff, breathing cold.\nWhat waits below has not been seen.', at(2.5, -108, 0), 180),
    souls.placedPickup('souls-hamlet', 'Souls Pickup', at(-60, 36, 0), { kind: 'souls', amount: 300, itemName: 'Soul of a Lost Undead' }),
    souls.placedPickup('estus-shard', 'Estus Shard', at(WATCHTOWER.x + 6, WATCHTOWER.z + 5, 0), { kind: 'flaskShard', amount: 1, itemName: 'Estus Shard' }),
    souls.placedPickup('souls-pond', 'Pond Souls', at(POND.x + 4, POND.z - 13, 0), { kind: 'souls', amount: 800, itemName: 'Soul of a Nameless Soldier' }),
    linkInstance(LEVEL.lever, lever),
    linkInstance(LEVEL.gate, gate),
    caveEntrance,
  ])

  // Breakable barrels about the hamlet and the bonfire (SoulsBreakable): hit one or roll into it.
  const barrels = souls.group('barrels', 'Barrels', barrelSpots().map(([x, z, yaw], i) =>
    linkInstance(BARREL_TEMPLATE, breakableBarrelNode(`placed:${i}`, at(x, z, 0), yaw))))

  const spawns = souls.group('spawns', 'Enemy Spawns', [
    souls.placedSpawn('hollow-a', 'Spawn Hollow A', at(-24, 16), 20, { templateName: 'Hollow' }),
    souls.placedSpawn('hollow-b', 'Spawn Hollow B', at(-13, -12), 0, { templateName: 'Hollow' }),
    souls.placedSpawn('hollow-c', 'Spawn Hollow C', at(-7, -44), 10, { templateName: 'Hollow' }),
    souls.placedSpawn('hollow-d', 'Spawn Hollow D', at(-2, -82), 0, { templateName: 'Hollow' }),
    souls.placedSpawn('hollow-e', 'Spawn Hollow E', at(14, -15), 300, { templateName: 'Hollow' }),
    souls.placedSpawn('caster', 'Spawn Sorcerer', at(WATCHTOWER.x - 7, WATCHTOWER.z + 7), 230, { templateName: 'Hollow Sorcerer' }),
    souls.placedSpawn('knight', 'Spawn Elite Knight', at(POND.x - 6, POND.z - 9), 300, { templateName: 'Elite Knight' }),
  ])

  // Torches either side of the cave's mouth, down the road through the hamlet and on its walls: by day you
  // hardly see them, by night they carry the valley.
  const lamps = valleyLamps([[-6.5, notchZ + 2], [6.5, notchZ + 2]])
  log('lamps', `${lamps.filter(l => l.kind === 'torch').length} standing, ${lamps.filter(l => l.kind === 'wallTorch').length} on walls`)
  const torches = souls.group('torches', 'Torches', lamps.map((l, i) =>
    placeFire(l.kind, `valley:${i}`, l.at, [0, Math.round(l.yaw * 100) / 100, 0])))

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
      sun, sky, skyLight, clouds, wind, timeOfDay,
      landscapeNode(),
      souls.group('water', 'Water', [pondWater(), pondProbe(), pondVolume(), pondZone(), ...floaters()]),
      hamletProbe(),
      souls.group('buildings', 'Buildings', placedBuildings),
      barrels,
      torches,
      interactables,
      spawns,
      navMesh,
    ],
    ambientLight: VALLEY_AMBIENT,
  })

  bakeValleyNavMesh(root, navMesh)

  const config = clone(souls.sourceScene.config)
  Object.assign(config.render, {
    // The High quality tier (SSIL, motion blur, TAA, bloom), the Sunny 16 fixed exposure, the
    // Cinematic lens look, and Cinematic depth of field focused where the camera boom puts the player.
    quality: 'high', motionBlurEnabled: true,
    ...PRESETS.exposure, ...PRESETS.look, ...PRESETS.dof, dofFocusDistance: PLAYER_ARM,
    // The preset's EV, as the exposure the renderer reads (it has no ev100 key). The Time of Day moves it.
    exposure: REFERENCE_ILLUMINANCE / (1.2 * 2 ** PRESETS.exposure.ev100),
    // The torches' cube shadows, for the nearest four: what makes the hamlet's night.
    pointShadowsEnabled: true, pointShadowResolution: 512, pointShadowDistance: 30,
    foliageCullDistance: PINE_CULL, foliageCellSize: 13,
    terrainLodEnabled: true, terrainLodDistance1: 150, terrainLodDistance2: 400, terrainLodStep1: 2, terrainLodStep2: 4,
    // A 2 km valley seen to 3 km: four detailed cascades over the first 150 m, then the far cascade
    // carries the ridges' and hills' shadows out to 1.5 km.
    shadowMapResolution: 4096, shadowCascades: 4, shadowDistance: 150, shadowFarDistance: 1500,
    // Pine shadows stop at 110 m: past that a tree's shadow is a few texels of the last cascade, and the
    // pines are what the foliage shadow pass spends its triangles on. The trees themselves still draw.
    foliageShadowDistance: 110,
  })
  return { scene: root, textures: [], ui: { version: 1, elements: [] }, config, assetHashes: {}, assetHashVersion: ASSET_HASH_VERSION, savedAt: souls.CREATED_AT }
}

// =====================================================================================================
// The dungeon (a second scene, through the skull cave)
// =====================================================================================================
//
// tools/valley/dungeon/: the medieval dungeon structure, dressed, lit and played. It is handed what it shares
// with the valley: the material and texture registries, the fire templates, the barrels, the souls content.

const DUNGEON_ID = id('scene:dungeon')
const DUNGEON_NAME = 'Dungeon'
const dungeon = buildDungeon({
  id, node, vars, souls, withScript, linkInstance, tex, pbrMaterial, libraryMaterial, modelNode, matJson, texIdsOf, log,
  placeFire, wallTorch, brazierCage, campfire, CAMPFIRE_MATS, CAGE_MAT, CAVE_DARK_MAT, SURFACES, rayHit,
  BARREL_TEMPLATE, breakableBarrelNode, mossRocks, MOSS_ROCK_MAT,
  ROOT, BUILD, PROPS, PROJECT_NAME, PRESETS, PLAYER_ARM, widenCamera, REFERENCE_ILLUMINANCE, ASSET_HASH_VERSION,
})

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
    description: 'A souls-like on a 2 km mountain valley with a day and night cycle: stamina combat, rolls, lock-on, bonfires and Estus, on landscape layers for ground, rock, snow, forest floor and trails, meadow grass and flowers, pine forest, moss rocks, a torch-lit hamlet with breakable barrels, and a skull cave down into a three-level dungeon with a boss in its throne arena.',
    order: 0,
  },
  models: [...propAssets, ...foliageAssets, ...dungeon.models],
  templates: [BARREL_TEMPLATE, DEBRIS_TEMPLATE, CAVE_TEMPLATE, ...Object.values(FIRE_TEMPLATES)],
  excludeTemplates: [LEVEL.torch.id, LEVEL.bonfire.id],
  tilesets: [FIRE_TILESET],
  extraScenes: [{ id: DUNGEON_ID, name: DUNGEON_NAME, build: dungeon.scene, refs: { modelIds: [souls.MANNEQUIN_MODEL, ...dungeon.models.map(a => a.id)] } }],
  // 2 km of valley: barrels, debris and enemies far from the camera freeze in place instead of
  // simulating against the terrain. The player opts out (simulationMode 'always').
  projectSettings: { engine: { simulationRange: 90 } },
  // A message's glyph is tuned for Hollow Keep's dusk exposure; under the valley's noon (and the dungeon,
  // held at the same EV) and the brighter exposure of its night it burned white. Lit for those instead.
  materialOverrides: { [souls.MAT.glyph]: { emissiveIntensity: 1.2 } },
  terrainMaterials: [{ id: TERRAIN_MATERIAL_ID, name: 'Valley Landscape', material: terrainMaterial, textureIds: [...new Set(Object.values(TERRAIN_TEX).flatMap(t => Object.values(t)))] }],
  folders: {
    scene: { [PROJECT_NAME]: '/Scenes', [DUNGEON_NAME]: '/Scenes' },
    template: {
      'Breakable Barrel': BARREL_DIR, 'Barrel Debris': BARREL_DIR, 'Skull Cave Entrance': CAVE_DIR,
      ...Object.fromEntries(Object.values(FIRE_TEMPLATES).map(t => [t.name, `${FIRE}/Templates`])),
    },
    model: { ...foliageFolder, ...buildingFolder, ...dungeon.folders },
    particleSystem: { 'Torch Embers': `${FIRE}/Particles`, 'Hearth Embers': `${FIRE}/Particles` },
    material: {
      ...materialFolder,
      'Dark Stone (placeholder)': SHARED_PROPS, 'Wood (placeholder)': SHARED_PROPS, 'Iron (placeholder)': SHARED_PROPS,
    },
    terrainMaterial: { 'Valley Landscape': LANDSCAPE },
    script: { 'Windmill Sails': `${BUILDINGS}/Scripts`, 'Fire Light': `${FIRE}/Scripts`, 'Day and Night': '/Environment/Scripts' },
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
const sceneBytes = fs.statSync(sceneFile).size
// Format 1 is what writeProject can author; format 2 is what can be checked in. The pine alone is ~60 MB
// of decimal text, stored in the model library, the terrain material and the scene's foliage layer, which
// put the scene file past GitHub's 100 MB limit. Packing interns it once, as binary, in split parts.
const largest = await packFormat2(OUT)
log(`${PROJECT_NAME} written to editor/public/examples/valley/`)
log(`  templates ${result.templates} · materials ${result.materials} · textures ${result.textureCount} · scene ${mb(sceneBytes)} unpacked · largest file ${mb(largest)}`)
log('Next:  npm --prefix editor run examples:list')
