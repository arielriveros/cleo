#!/usr/bin/env node
// Authors the "Valley" example into applications/editor/public/examples/valley/.
//
//     python tools/valley/prepare.py                         # once: textures -> build/valley_prepared/
//     node --max-old-space-size=12288 tools/valley/build.mjs
//     npm --prefix editor run examples:list                  # regenerates the gallery index
//
// The souls-like content, outdoors. Every playable element — the player, both weapons, the four
// enemy types, the Warden, the bonfire, the fog gate, the lever and gate, messages, pickups, the HUD — is
// the souls demo's own, imported from tools/soulsDemo/build.mjs and linked to the same templates. What is
// new is the level: a 2 km landscape from build/valley_height_4097_16bit.png with an eleven-surface landscape
// material (ground, dirt, rock, snow, a clay and sand pond, painted roads, tracks and stone paths),
// pre-scattered trees, bushes and grass made with the Foliage Creator (creatorFoliage.mjs), and four FBX
// buildings on the pads the heightmap was flattened for.
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
  DIRT_ROADS, FENCES, GATE_PLAZA, HAMLET, NOTCH_HALF_WIDTH, POND, ROADS, SPAWN, SUN_TRAVEL, TERRAIN, WATCHTOWER,
  catmullRom, distanceToPolyline, rimRadius,
} from './layout.mjs'
import {
  DIRT_ROAD_CHANNEL, FOREST_CHANNEL, paintDirtPatches, FOREST_SLOT, MASK_RES, MASK_SLICES, PATH_CHANNEL, SLOT_CHANNELS, TRAIL_CHANNEL,
  TRAIL_SLOT, loadLayerMath, paintForestFloor, paintPolyline, paintPond, sampleMask, surfaceWeights, trailMask, valleyTerrainMaterial,
} from './landscape.mjs'
import {
  buildMossRocks, cliffDistanceField, instancesBlob, jitteredCandidates, layerModels, modelAsset, onGround, onSurface, rng, triangles,
} from './foliage.mjs'
import { CREATOR_FOLIAGE, TREE_CULL, generateCreatorFoliage } from './creatorFoliage.mjs'
import { buildProps } from './props.mjs'
import { houseColliders } from './houses.mjs'
import { fitOccluders } from './occluders.mjs'
import { buildKnight } from './knight.mjs'
import { buildHollow, buildStrongKnight } from './enemies.mjs'
import { WATER_SOURCE, WATER_UNIFORMS } from './water.mjs'
import { boundsOf, convexShape, geometryJson, mergeParts, partsOf, readGltf } from './meshes.mjs'
import { buildBarrel, buildSkullCave } from './setPieces.mjs'
import { buildCampfire, buildStandingTorch, buildWallTorch, rayHit } from './torches.mjs'
import { buildCage, buildCandle } from './dungeon/props.mjs'
import { buildDungeon } from './dungeon/scene.mjs'

const { ROOT, stableId: soulsId, clone, matJson, material, textures, LEVEL, linkInstance, withScript } = souls
const BUILD = path.join(ROOT, 'build')
const PREPARED = path.join(BUILD, 'valley_prepared')
const OUT = path.join(ROOT, 'applications', 'editor', 'public', 'examples', 'valley')
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
  dirt: groundTex('dirt', 'Dirt'), clay: groundTex('clay', 'Pond Clay'),
  sand: groundTex('sand', 'Shore Sand'), path: groundTex('path', 'Stone Path'),
}

/** A PBR material in Material.serialize()'s shape, with only the slots that are given. */
function pbrMaterial({ diff, nor, arm, rough, ao, mask, side = 'front', roughness = 1, castShadow = true, tint = [1, 1, 1], wind, ...extra }) {
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
      ...(ao ? { occlusionMap: ao } : {}),
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

// The dungeon's rubble: the scanned moss rocks, no longer scattered on the valley's ground.
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
// ----- the knight (the player) -------------------------------------------------------------------------
// Three PBR metallic materials, the file's own (blinn2, blinn1, blinn3 in material order): base colour,
// normal, and the packed occlusion/roughness/metal map as ARM; the two cut-out ones keep their alpha.
const KNIGHT_DIR = '/Characters/Player/Knight'
const knightMaterial = (blinn, name, mask) => libraryMaterial(`knight-${blinn}`, name, `${KNIGHT_DIR}/Materials`, pbrMaterial({
  diff: tex(`knight_${blinn}_diff.jpg`, `${KNIGHT_DIR}/Textures`, `${name} Base Color`),
  nor: tex(`knight_${blinn}_nor.png`, `${KNIGHT_DIR}/Textures`, `${name} Normal`),
  arm: tex(`knight_${blinn}_arm.jpg`, `${KNIGHT_DIR}/Textures`, `${name} ARM`),
  ...(mask ? { mask: tex(`knight_${blinn}_mask.png`, `${KNIGHT_DIR}/Textures`, `${name} Mask`) } : {}),
  metallic: 1, roughness: 1, side: 'double',
}))
const KNIGHT_MATERIALS = [
  knightMaterial('blinn2', 'Knight Armour', true),
  knightMaterial('blinn1', 'Knight Plate', false),
  knightMaterial('blinn3', 'Knight Cloth', true),
]

// ----- the enemies' own characters --------------------------------------------------------------------
// Both files are spec-gloss; prepare.py converts each material to base colour / ARM / normal.
const enemyMaterial = (dir, key, prefix, name, metallic) => libraryMaterial(key, name, `${dir}/Materials`, pbrMaterial({
  diff: tex(`${prefix}_diff.jpg`, `${dir}/Textures`, `${name} Base Color`),
  nor: tex(`${prefix}_nor.png`, `${dir}/Textures`, `${name} Normal`),
  arm: tex(`${prefix}_arm.jpg`, `${dir}/Textures`, `${name} ARM`),
  metallic, roughness: 1, side: 'double',
}))
const HOLLOW_DIR = '/Characters/Enemies/Hollow'
// The FBX's three UDIM tiles, in its material order (Ch05_body, _body1, _body2).
const HOLLOW_MATERIALS = ['1001', '1002', '1003'].map((tile, i) => enemyMaterial(HOLLOW_DIR, `hollow-${tile}`, `hollow_${tile}`, `Hollow Body ${i + 1}`, 1))
const ELITE_DIR = '/Characters/Enemies/Elite Knight'
const STRONG_KNIGHT_MATERIALS = [
  enemyMaterial(ELITE_DIR, 'strong-knight-cloth', 'strong_knight_cloth', 'Strong Knight Cloth', 1),
  enemyMaterial(ELITE_DIR, 'strong-knight-armour', 'strong_knight_knight', 'Strong Knight Armour', 1),
  enemyMaterial(ELITE_DIR, 'strong-knight-weapons', 'strong_knight_weapons', 'Strong Knight Weapons', 1),
]

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
  // A luminance (1 = 78,643 nits): 2 was tuned under a tenth of the exposure, and GLOW_LUMINANCE carries it
  // over to the whole exposure at a torch-lit night's EV (see FLAME_LUMINANCE below).
  overdrive: +(2 * souls.GLOW_LUMINANCE).toPrecision(3), tiles: {}, terrains: [], variantSets: [], textureIds: [FIRE_TEXTURE],
}
const FIRE_FRAMES = Array.from({ length: 32 }, (_, i) => i)

/**
 * The flames and embers take the camera's exposure whole, as the torch's light does (Sprite /
 * ParticleSystemNode exposureWeight 1). Their brightness is a luminance: the flame sprite's tileset
 * `overdrive` and the embers' colour intensity (converted in souls `physicalEmitter`) are set so a flame
 * looks as it was tuned at a torch-lit night's exposure (EV 5). It fades into the noon sun, and blazes on a
 * moonlit night, where the eye has opened up further.
 */

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
      // Its base sits inside the torch head or the fire pit's logs: shown through them, not cut off.
      softness: Math.round(Math.min(0.4, height * 0.5) * 100) / 100,
    },
    animation: { frames: FIRE_FRAMES, frameSource: 'node', fps: 24, loop: true, randomStart: true },
  })
}

/**
 * A fire's light: warm and photometric, in real lumens (a torch about 1,000, a candle 60), the same at noon,
 * at midnight and underground. Nothing scales them: by day a torch is lost in the sun, and at night and in
 * the dungeon the auto exposure opens up until it carries the scene, which is the eye's job, not the lamp's.
 *
 * Torches cast shadows (`castShadows`); hearths, candles and braziers do not. A shadowed point light
 * renders everything in its range six times, again whenever something moves near it, and the renderer
 * shadows only the nearest four, so the torches, spaced well apart, are the ones that get them.
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
/**
 * A fire's embers (a steady drift) and sparks. Sparks pop ONE at a time: `bursts` single sparks per
 * five-second cycle, `interval` seconds apart, each landing with probability `chance` — a crackle, never
 * a fountain of seven at once.
 */
function emberEmitters(key, { rate, radius, interval, chance, bursts, speed }) {
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
      spawn: [souls.mod('spawnRate', { rate: 0 }), souls.mod('spawnBurst', { bursts: [{ time: 0.3, count: 1, cycles: bursts, interval, probability: chance }] })],
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
  emberEmitters('torch', { rate: 6, radius: 0.06, interval: 1.6, chance: 0.7, bursts: 3, speed: [1.2, 3] }),
  { center: [0, -1.1, 0], extents: [1.8, 1.9, 1.8] }, fxLod(8, 16, 26))
const HEARTH_FX = souls.vfx('valley:hearth-embers', 'Hearth Embers',
  emberEmitters('hearth', { rate: 16, radius: 0.3, interval: 1.4, chance: 0.9, bursts: 3, speed: [1.6, 3.6] }),
  { center: [0, 0.8, 0], extents: [2.6, 2.4, 2.6] }, fxLod(12, 24, 45))
const fx = (key, asset, position) => {
  return souls.particles(`valley:${key}`, 'Embers', asset, { position })
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
      fireLight(`wall-torch:${key}`, 850, 7, [f[0], f[1] + 0.2, f[2] + 0.5], true),
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
      fireLight(`torch:${key}`, 1000, 7, above(f, 0.3), true),
    ],
  }), 'ValleyFireLight')
  n.body = { ...souls.staticBody('cylinder'), shapes: [{ type: 'cylinder', radius: 0.12, height: f[1], numSegments: 8, offset: [0, f[1] / 2, 0], rotation: [0, 0, 0] }] }
  return n
}

/** The fire of a bonfire or fire pit: flames over the logs, embers and sparks, and its light, under one FireLight. */
function hearth(key, { height = 1.2, lumens = 1100, range = 10, base = [0, 0.3, 0], name = 'Fire' } = {}) {
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
      hearth(`fire-pit:${key}`, { lumens: 1400, range: 11 }),
    ],
  })
  n.body = { ...souls.staticBody('cylinder'), shapes: [{ type: 'cylinder', radius: 0.75, height: 0.4, numSegments: 12, offset: [0, 0.2, 0], rotation: [0, 0, 0] }] }
  return n
}

/** A fire laid in a fireplace: the flames, embers and light of a bonfire with no campfire under them. */
function hearthNode(key, position = [0, 0, 0]) {
  const n = hearth(`hearth-node:${key}`, { height: 1.0, lumens: 1600, range: 11, base: [0, 0, 0], name: 'Hearth' })
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
      fireLight(`candle:${key}`, 60, 3, [0, candle.flame + 0.08, 0]),
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
      fireLight(`brazier:${key}`, 1300, 9, [0, 0.55, 0]),
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
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite-node', '--config', 'vitest.config.ts', 'tools/valley/presets.ts'],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 << 20 })
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
// The lesser roads on their own channel, and the pond's clay basin and sand bank.
const dirtRoadLines = DIRT_ROADS.map(r => catmullRom(r.points, 0.5))
DIRT_ROADS.forEach((r, i) => paintPolyline(mask, dirtRoadLines[i], r.halfWidth, r.blend, DIRT_ROAD_CHANNEL))
paintPond(mask, heights, POND, POND_LEVEL, POND_REACH)
for (const [i, r] of DIRT_ROADS.entries()) {
  const line = dirtRoadLines[i]
  let length = 0, steepest = 0
  for (let k = 1; k < line.length; k++) length += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1])
  for (const [x, z] of line) steepest = Math.max(steepest, heights.slopeAt(x, z))
  const wet = line.filter(([x, z]) => Math.hypot(x - POND.x, z - POND.z) < POND_REACH).length
  log(`dirt road ${r.key}: ${length.toFixed(0)} m, steepest ${steepest.toFixed(1)}°${wet ? `, ${wet} samples in the pond` : ''}`)
}

// =====================================================================================================
// Buildings
// =====================================================================================================

const props = await buildProps(ROOT, path.join(BUILD, 'props'))
log('props converted', props.map(p => `${p.key} ${p.triangles} tris ${p.size.map(v => v.toFixed(1)).join('x')} m`).join(', '))

/**
 * The houses the knight can walk into: walls, lintels and a roof as boxes (houses.mjs) instead of a hull
 * that fills them. The granary and the windmill keep their hulls.
 */
const ENTERABLE = new Set(['house', 'long-house'])
/** The player capsule's height, plus headroom: a doorway lower than this over the floor is logged as a problem. */
const DOOR_CLEARANCE = 1.8
const houseShapes = new Map()
for (const p of props) {
  if (!ENTERABLE.has(p.key)) continue
  const h = houseColliders(p.parts.map(x => x.part))
  const kinds = {}
  for (const b of h.boxes) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1
  if (!kinds.wall) { log(`house ${p.key}: no walls found, keeping its hull`); continue }
  const headroom = h.doorLows.length ? h.doorLows[0] - h.floor : undefined
  log(`house ${p.key}: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')} and a roof hull; floor ${h.floor.toFixed(2)} m,`
    + ` lowest lintel ${headroom?.toFixed(2) ?? 'none'} m over it${headroom !== undefined && headroom < DOOR_CLEARANCE ? '  ** TOO LOW FOR THE KNIGHT **' : ''}`)
  // The roof: one hull over everything above the eave (houses.mjs).
  houseShapes.set(p.key, { ...h, roof: convexShape(ROOT, [{ positions: h.roofPoints }]) })
}

/** Where each building wants to stand (reference pads / sites) and which way it faces, in radians. */
const SITES = {
  house: { x: -50, z: 30, yaw: 0.35 },
  'long-house': { x: -18, z: 44, yaw: -2.4 },   // east of the road: Cottage B's pad sits on it
  // Searched wider: the Old House's yard, wide since its scale-up, covers the granary's old pad.
  silo: { x: -58, z: 48, yaw: 0.8, reach: 30 },
  // The sails face the valley centre. Local -X is the sail side, and Ry(yaw) takes -X to (-cos, 0, sin).
  windmill: { x: WATCHTOWER.x, z: WATCHTOWER.z, yaw: Math.atan2(-WATCHTOWER.z, WATCHTOWER.x) },
}
/** The bonfire, by the hamlet's well, just off the road. */
/** The bonfire, a few metres to the east of where the player first stands, off the road. */
const BONFIRE = { x: SPAWN.x + 5.5, z: SPAWN.z - 3 }

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
    const reach = site.reach ?? 10
    for (let dz = -reach; dz <= reach; dz += 1) for (let dx = -reach; dx <= reach; dx += 1) {
      const cx = site.x + dx, cz = site.z + dz
      const pts = footprint(cx, cz, site.yaw)
      const hs = pts.map(([x, z]) => heights.heightAt(x, z))
      const range = Math.max(...hs) - Math.min(...hs)
      let cost = range + Math.hypot(dx, dz) * 0.05
      if (pts.some(([x, z]) => sampleMask(mask, x, z) > 0.05)) cost += 50
      if (Math.hypot(cx - BONFIRE.x, cz - BONFIRE.z) < radius + 4) cost += 50
      // Off the dirt roads, by the margin the check below asserts (and a little more).
      if (dirtRoadLines.some(line => distanceToPolyline(cx, cz, line) < radius * 0.75)) cost += 50
      for (const q of placed) if (Math.hypot(cx - q.x, cz - q.z) < radius + q.radius + 1) cost += 50
      if (!best || cost < best.cost) best = { cost, x: cx, z: cz, y: Math.min(...hs) - 0.05, range }
    }
    placed.push({ ...best, key: p.key, yaw: site.yaw, radius, prop: p })
  }
  return placed
}
const buildings = placeBuildings()
for (const b of buildings) log(`building ${b.key} at (${b.x}, ${b.y.toFixed(2)}, ${b.z}) ground range ${b.range.toFixed(2)} m${b.cost >= 50 ? '  ** CROWDED **' : ''}`)
for (const [i, r] of DIRT_ROADS.entries()) for (const b of buildings) {
  const d = distanceToPolyline(b.x, b.z, dirtRoadLines[i])
  if (d < b.radius * 0.7) throw new Error(`dirt road ${r.key} runs through ${b.key} (${d.toFixed(1)} m from its centre)`)
}

/**
 * Level the ground inside each enterable house to its base, easing back to the hillside over a few
 * metres outside. A house is set at the LOWEST ground under its footprint so it never floats, which on a
 * slope left the floor inside up to a metre under the terrain — and that metre came straight off the
 * headroom under the lintels. Cut AND fill inside, so the floor is the base everywhere; outside, only the
 * blend. Done on the shipped 1 m grid, before anything else reads the ground round the houses.
 */
function levelHouseFloors() {
  const MARGIN = 3
  const R = Math.round(Math.sqrt(heights.grid.length)), e = heights.element, half = TERRAIN.size / 2
  for (const b of buildings) {
    if (!houseShapes.has(b.key)) continue
    const hx = b.prop.size[0] / 2, hz = b.prop.size[2] / 2
    // To the house's raised floor (houses.mjs): the terrain is the floor the knight walks on inside, and
    // its slope up to the walls is how he climbs to the doorway.
    const target = b.y + houseShapes.get(b.key).floor - 0.02
    const reach = Math.hypot(hx, hz) + MARGIN
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw)
    let moved = 0, deepest = 0
    const c0 = Math.max(0, Math.floor((b.x - reach + half) / e)), c1 = Math.min(R - 1, Math.ceil((b.x + reach + half) / e))
    const r0 = Math.max(0, Math.floor((b.z - reach + half) / e)), r1 = Math.min(R - 1, Math.ceil((b.z + reach + half) / e))
    for (let r = r0; r <= r1; r++) for (let col = c0; col <= c1; col++) {
      const dx = col * e - half - b.x, dz = r * e - half - b.z
      const lx = dx * c - dz * s, lz = dx * s + dz * c
      const d = Math.hypot(Math.max(Math.abs(lx) - hx, 0), Math.max(Math.abs(lz) - hz, 0))
      if (d >= MARGIN) continue
      const t = d === 0 ? 1 : 1 - d / MARGIN * d / MARGIN * (3 - 2 * d / MARGIN)
      const i = r * R + col
      const h = heights.grid[i]
      // Outside, eased both ways: up to the floor at the walls, back to the slope MARGIN out.
      const next = d === 0 ? target : h + (target - h) * t
      if (next !== h) { deepest = Math.max(deepest, Math.abs(h - next)); heights.grid[i] = next; moved++ }
    }
    log(`house ${b.key}: floor levelled at ${target.toFixed(2)} m, ${moved} terrain samples, largest change ${deepest.toFixed(2)} m`)
  }
}
levelHouseFloors()

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

/**
 * A placed copy of a building: the asset's subtree, linked. An enterable house gets its wall, lintel and
 * roof boxes (in the prop's own space, which is the node's); anything else a convex collider over its body.
 */
function placedBuilding(b, asset) {
  const copy = clone(asset.nodeJson)
  let i = 0
  const rekey = (n) => { n.id = id(`placed:${b.key}:${i++}`); (n.children ?? []).forEach(rekey) }
  rekey(copy)
  copy.position = [b.x, Math.round(b.y * 1000) / 1000, b.z]
  copy.rotation = [0, Math.round(b.yaw * 180 / Math.PI * 1000) / 1000, 0]
  const house = houseShapes.get(b.key)
  // Walls stop swings like the dungeon's do; a hull never needed to say so.
  copy.variables = vars(house ? { __modelId: asset.id, blocksSwings: true } : { __modelId: asset.id })
  copy.body = {
    ...souls.staticBody('box'),
    shapes: house
      ? [...house.boxes.map(x => ({ type: 'box', width: x.size[0], height: x.size[1], depth: x.size[2], offset: x.center, rotation: x.rotation })), house.roof]
      : [convexShape(ROOT, b.prop.parts.map(x => x.part))],
  }
  if (house) HOUSE_WALLS.set(copy, [...house.boxes.map(x => x.kind === 'wall'), false])
  return copy
}

/**
 * Placed houses -> which of their body's shapes are walls. The navmesh takes only those from a house:
 * every roof slab and lintel top would otherwise be tessellated as a floor nobody can reach (that nearly
 * doubled the baked mesh), and only the walls need carving round.
 */
const HOUSE_WALLS = new Map()

/** A point in a placed building's own space, in the world: Ry(yaw), as the footprint search turns it. */
function buildingToWorld(b, [lx, ly, lz]) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw)
  return [round3(b.x + lx * c + lz * s), round3(b.y + ly), round3(b.z - lx * s + lz * c)]
}

/** Occluders inside each enterable house's walls (occluders.mjs), placed with the house. */
function buildingOccluders() {
  const out = []
  for (const b of buildings) {
    const house = houseShapes.get(b.key)
    if (!house) continue
    fitOccluders(house.grid, house.boxes.filter(x => x.kind === 'wall')).forEach((o, i) => out.push(node(`${b.prop.name} Occluder ${i + 1}`, 'occluder', {
      id: id(`occluder:${b.key}:${i}`), position: buildingToWorld(b, o.center),
      rotation: [0, round3(b.yaw * 180 / Math.PI), 0], occluder: { size: o.size, enabled: true },
    })))
  }
  log('occluders', `${out.length} inside the houses' walls`)
  return out
}

// =====================================================================================================
// Foliage
// =====================================================================================================

// Every plant is the Foliage Creator's (creatorFoliage.mjs): generated headless with its LOD ladder, its
// materials and, for trees, its octahedral impostor, then read back as parts like any other mesh here.
const mossRocks = buildMossRocks(path.join(MOSS_SRC, 'rock_moss_set_02_1k.gltf'))
const creatorPlants = generateCreatorFoliage(ROOT, BUILD, CREATOR_FOLIAGE, log)

const TEXTURE_LABELS = { grass: 'Blades', grassCard: 'Clump Card', bark: 'Bark', barkNormal: 'Bark Normal', barkOrm: 'Bark ARM', leaves: 'Leaves', rockAlbedo: 'Albedo', rockNormal: 'Normal' }
/**
 * A Creator material (its MaterialSpec) as a library material, its textures the generator's own PNGs:
 * what importing the Creator's .glb would give -- cutout on the base colour's alpha, double-siding,
 * translucency and the wind response included.
 */
const BARK_LABELS = { bark_pine: 'Pine Bark', bark_oak: 'Oak Bark' }
/** A scanned bark set (prepare.py `barks`), shared by every tree that wears it. */
const scannedBark = (prefix) => ({
  diff: tex(`${prefix}_diff.jpg`, `${FOLIAGE}/Textures`, `${BARK_LABELS[prefix]} Base Color`),
  nor: tex(`${prefix}_nor.png`, `${FOLIAGE}/Textures`, `${BARK_LABELS[prefix]} Normal`),
  arm: tex(`${prefix}_arm.jpg`, `${FOLIAGE}/Textures`, `${BARK_LABELS[prefix]} ARM`),
})
const SCANNED_BARK = Object.fromEntries([...new Set(CREATOR_FOLIAGE.map(s => s.bark).filter(Boolean))].map(b => [b, scannedBark(b)]))
function creatorMaterial({ spec, manifest, dir }, key, m) {
  const texOf = (t) => t ? tex(path.join(dir, manifest.textures[t]), `${FOLIAGE}/Textures`, `${spec.name} ${TEXTURE_LABELS[t] ?? t}`) : undefined
  // A tree with scanned bark wears it in place of the generated maps; its roughness comes from the ARM.
  const scanned = key === 'bark' && spec.bark ? SCANNED_BARK[spec.bark] : null
  return libraryMaterial(`creator:${spec.key}:${key}`, `${spec.name} ${m.name}`, `${FOLIAGE}/Materials`, pbrMaterial({
    // Every channel the Creator writes: colour, normal, and AO / roughness / metallic packed into one map.
    ...(scanned ?? { diff: texOf(m.baseColorTexture), nor: texOf(m.normalTexture), arm: texOf(m.ormTexture) }),
    roughness: scanned ? 1 : m.roughness, tint: scanned ? [1, 1, 1] : m.baseColor.slice(0, 3),
    side: m.doubleSided ? 'double' : 'front', castShadow: spec.rule.castShadows, wind: m.wind,
    ...(m.alphaCutoff ? { alphaCutoff: m.alphaCutoff } : {}),
    ...(m.translucency ? { translucency: m.translucency } : {}),
    ...(m.metallic ? { metallic: m.metallic } : {}),
    ...(m.emissive ? { emissiveFactor: m.emissive, emissiveIntensity: m.emissiveIntensity ?? 1 } : {}),
  }))
}

const FOLIAGE_PROTOS = creatorPlants.map(plant => {
  const { spec, manifest } = plant
  const materialIds = Object.fromEntries(Object.entries(manifest.materials).map(([k, m]) => [k, creatorMaterial(plant, k, m)]))
  const c = manifest.collider
  return {
    key: spec.key, name: spec.name, group: spec.group, kind: spec.kind, plant,
    levels: plant.levels.map(l => l.parts.map(part => ({ name: part.name, part, materialId: materialIds[part.material] }))),
    distances: plant.levels.slice(1).map(l => l.distance), cull: manifest.cullDistance,
    // The undergrowth belongs to the Forest Floor (its own foliageInclude); everything else to the ground.
    surface: spec.group === 'undergrowth' ? FOREST_SLOT : undefined,
    // The Creator's trunk fit, a little wider so the camera and the player keep off the bark.
    rule: { ...spec.rule, collision: c?.shape === 'cylinder'
      ? { shape: 'cylinder', radius: Math.round(Math.max(0.25, c.radius * 1.3) * 1000) / 1000, height: Math.round(c.height * 1000) / 1000 } : null },
    cellSize: spec.cellSize,
  }
})
const ofGroup = (group) => FOLIAGE_PROTOS.filter(f => f.group === group)
log('foliage LODs', FOLIAGE_PROTOS.map(f => `${f.name} ${f.levels.map(l => triangles(l.map(x => x.part))).join('/')}`).join(', '))

const foliageAssets = FOLIAGE_PROTOS.map(f => modelAsset({
  id: id(`model:${f.key}`), idOf: id, name: f.name, levels: f.levels, distances: f.distances,
  cullDistance: f.cull, materialJson: matJson, vars, node,
}))

// The trees' OCTAHEDRAL impostors, baked by the Creator from each tree's last mesh level (the one they
// take over from, so the hand-over does not pop) with the engine's own baker. Registered under the
// editor's ids for them, so a re-bake in the terrain material REPLACES these rather than adding more;
// clamp-wrapped (the default): repeat would blend the atlas's outer frames into its opposite edge.
FOLIAGE_PROTOS.forEach((f, i) => {
  const imp = f.plant.manifest.impostor
  if (!imp) return
  const asset = foliageAssets[i]
  const texId = `${asset.id}__impostor`, normalId = `${asset.id}__impostorNormal`
  textures.add(texId, path.join(f.plant.dir, imp.albedo), { mipMap: true }, 'image/png')
  textures.add(normalId, path.join(f.plant.dir, imp.normal), { mipMap: true }, 'image/png')
  TEXTURE_ENTRIES.push({ folder: `${FOLIAGE}/Textures`, name: `${asset.name} Impostor`, id: texId, ext: 'png' })
  TEXTURE_ENTRIES.push({ folder: `${FOLIAGE}/Textures`, name: `${asset.name} Impostor Normals`, id: normalId, ext: 'png' })
  f.billboard = { textureId: texId, textures: { normal: normalId }, octahedral: imp.info, distance: imp.distance }
  f.impostorSize = imp.albedoSize
})
const RULES = FOLIAGE_PROTOS.map((f, i) => ({
  kind: 'mesh', id: id(`rule:${f.key}`), name: f.name, modelId: foliageAssets[i].id,
  density: f.rule.density, densityUnit: 'm2', minScale: f.rule.minScale, maxScale: f.rule.maxScale,
  cullDistance: f.cull, billboard: f.billboard ?? null, ...(f.billboard ? { impostorSize: f.impostorSize } : {}),
  castShadows: f.rule.castShadows, collision: f.rule.collision,
  ...(f.rule.cameraDither ? { cameraDither: true } : {}),
}))

// Ground rules on the Ground, the undergrowth on the Forest Floor that carries it. Every painted road,
// path and the pond keep the small plants (grass and bushes) off.
const SMALL_PLANTS = FOLIAGE_PROTOS.filter(f => f.kind !== 'tree').map(f => f.name)
const terrainMaterial = valleyTerrainMaterial(TERRAIN_TEX, RULES.filter((_, i) => !FOLIAGE_PROTOS[i].surface), SMALL_PLANTS, {
  forestFoliage: RULES.filter((_, i) => FOLIAGE_PROTOS[i].surface === FOREST_SLOT),
})
/** Index of a slot's surface in `surfaceWeights` (0 is the ground). */
const surfaceIndex = (slotId) => 1 + terrainMaterial.slots.findIndex(s => s.id === slotId)
const TERRAIN_MATERIAL_ID = id('terrain-material')

// ----- where things may grow -------------------------------------------------------------------------

const cliffDistance = cliffDistanceField(heights)
log('cliff distance field')
const inPlazaZone = (x, z) => z < -100 && Math.abs(x) < 20

/**
 * Forest tracks: dead ends off the roads into the pine belt. Each starts on a road 35-80 m from the cliff
 * foot (three such points, at least 60 m apart) and walks downhill on the cliff distance, toward the
 * cliffs, in 2 m steps until it is among the trees or the ground steepens.
 */
const trackStarts = []
for (const line of roadLines) for (const [x, z] of line) {
  const d = cliffDistance(x, z)
  if (d < 35 || d > 80 || trackStarts.length >= 3 || inPlazaZone(x, z)) continue
  if (trackStarts.some(([sx, sz]) => Math.hypot(x - sx, z - sz) < 60)) continue
  if (buildings.some(b => Math.hypot(x - b.x, z - b.z) < b.radius + 15)) continue
  trackStarts.push([x, z])
}
const trackLines = trackStarts.map(([x, z]) => {
  let dx = 0, dz = 0
  const pts = [[x, z]]
  for (let k = 0; k < 120 && cliffDistance(x, z) > 12; k++) {
    const gx = cliffDistance(x + 2, z) - cliffDistance(x - 2, z), gz = cliffDistance(x, z + 2) - cliffDistance(x, z - 2)
    const g = Math.hypot(gx, gz) || 1
    // Steer toward the cliff, keeping some of the heading so the track curves rather than zigzags.
    dx = dx * 0.6 - (gx / g) * 0.4; dz = dz * 0.6 - (gz / g) * 0.4
    const n = Math.hypot(dx, dz) || 1
    x += (dx / n) * 2; z += (dz / n) * 2
    if (heights.slopeAt(x, z) > 22) break
    pts.push([x, z])
  }
  return catmullRom(pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1), 0.5)
})
trackLines.forEach((line, i) => {
  paintPolyline(mask, line, 1.0, 2, DIRT_ROAD_CHANNEL)
  log(`forest track ${i}: ${line.length} samples, ends (${line[line.length - 1].map(v => v.toFixed(0)).join(', ')})`)
})

/**
 * Stone paths: from each building's road side to the nearest point of the main road, and a paved patch
 * round the bonfire.
 */
const mainLine = roadLines[0]
const pathLines = buildings.map(b => {
  const near = mainLine.reduce((best, p) => Math.hypot(p[0] - b.x, p[1] - b.z) < Math.hypot(best[0] - b.x, best[1] - b.z) ? p : best)
  const d = Math.hypot(near[0] - b.x, near[1] - b.z) || 1
  const start = [b.x + (near[0] - b.x) / d * b.radius * 0.6, b.z + (near[1] - b.z) / d * b.radius * 0.6]
  return catmullRom([start, near], 0.5)
})
for (const line of pathLines) paintPolyline(mask, line, 1.1, 1.6, PATH_CHANNEL)
paintPolyline(mask, [[BONFIRE.x - 0.5, BONFIRE.z], [BONFIRE.x + 0.5, BONFIRE.z]], 3, 1.5, PATH_CHANNEL)
// Bare earth: patches through the meadows, and the ground worn bare about each building and the bonfire.
paintDirtPatches(mask, heights, {
  wear: (x, z) => {
    let w = 1 - Math.min(1, Math.max(0, (Math.hypot(x - BONFIRE.x, z - BONFIRE.z) - 4) / 5))
    for (const b of buildings) w = Math.max(w, 0.8 * (1 - Math.min(1, Math.max(0, (Math.hypot(x - b.x, z - b.z) - b.radius) / 4))))
    return w
  },
})

/** Distance to anything painted for walking on: roads, dirt roads, tracks and stone paths. */
const walkLines = [...roadLines, ...dirtRoadLines, ...trackLines, ...pathLines]
const pathDistance = (x, z) => {
  let best = Infinity
  for (const l of walkLines) best = Math.min(best, distanceToPolyline(x, z, l))
  return best
}

const keepClear = [
  ...buildings.map(b => ({ x: b.x, z: b.z, r: b.radius + 1.5 })),
  { x: BONFIRE.x, z: BONFIRE.z, r: 4 },
  { x: SPAWN.x, z: SPAWN.z, r: 3 },
  { x: POND.x, z: POND.z, r: POND_REACH + 3 },
]
const clear = (x, z, pad = 0) => keepClear.every(c => Math.hypot(x - c.x, z - c.z) > c.r + pad)
const inPlaza = (x, z) => z < -112 && Math.abs(x) < 16
const inValley = (x, z) => heights.heightAt(x, z) < 25 && Math.hypot(x, z) < 200 && cliffDistance(x, z) > 2

/** Every tree in the valley (pines in the belt, the stands and about the hamlet), for the forest volumes. */
const TREE_POINTS = []

/** `points` dealt among `kinds` at random, weighted by each one's rule density. */
function deal(points, kinds, random) {
  const per = kinds.map(() => [])
  const total = kinds.reduce((sum, f) => sum + f.rule.density, 0)
  for (const p of points) {
    let pick = random() * total, k = 0
    while (k < kinds.length - 1 && pick > kinds[k].rule.density) { pick -= kinds[k].rule.density; k++ }
    per[k].push(p)
  }
  return per
}

function scatter() {
  const layers = []
  const counts = {}
  const add = (kinds, per, seed, sink) => per.forEach((pts, k) => {
    counts[kinds[k].name] = pts.length
    layers.push({ proto: kinds[k], points: pts, seed: seed + k, sink })
  })
  // Pines FIRST: the forest floor is painted where they stand, and everything after reads that mask.
  // A dense belt at the cliff foot and a few stands in the valley (the pine variants, dealt at random),
  // and sparse spruce beyond the rim.
  {
    const random = rng(0x914e)
    const pines = ofGroup('pine'), highland = ofGroup('highland')
    const allowed = onGround(math, terrainMaterial, mask, heights, pines[0].name)
    const highAllowed = onGround(math, terrainMaterial, mask, heights, highland[0].name)
    const roadsClear = (x, z, d) => pathDistance(x, z) > d
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
      return h > 55 && h < 210 && cliffDistance(x, z) > 6 && heights.slopeAt(x, z) < 28 && highAllowed(x, z)
    })
    const pts = [...belt, ...stands]

    // More pines about the hamlet and the pond, among the meadows the stands leave open, and up the lower
    // slopes around them (the valley floor proper is small). A fine candidate grid, thinned by a spacing
    // test, so the valley's small floor still gets its trees.
    const placed = []
    jitteredCandidates(rng(0x1ac0), { minX: -170, maxX: 170, minZ: -170, maxZ: 170 }, 0.02, (x, z, r) =>
      r() < 0.5 && heights.heightAt(x, z) < 45 && heights.slopeAt(x, z) < 24 && cliffDistance(x, z) > 10
        && clear(x, z, 6) && roadsClear(x, z, 6) && !inPlaza(x, z)
        && Math.min(Math.hypot(x - HAMLET.x, z - HAMLET.z), Math.hypot(x - POND.x, z - POND.z)) < 130
        && Math.hypot(x - SPAWN.x, z - SPAWN.z) > 18 && pts.every(([px, pz]) => Math.hypot(x - px, z - pz) > 8)
        && placed.every(([jx, jz]) => Math.hypot(x - jx, z - jz) > 10) && allowed(x, z) && placed.push([x, z]) > 0)

    TREE_POINTS.push(...pts, ...placed)
    add(pines, deal([...pts, ...placed], pines, rng(0x9151)), 0x9150, 0.25)
    add(highland, deal(beyond, highland, rng(0x9161)), 0x9160, 0.25)
    counts.pines = `belt ${belt.length}, valley ${stands.length + placed.length}, beyond ${beyond.length}`
    // The needle litter under them: the Forest Floor surface's mask channel.
    paintForestFloor(mask, [...pts, ...beyond])
    paintForestFloor(mask, placed, 3.5, 7.5)
  }
  // Grass: one jittered grid over the valley floor, each candidate given to one kind by its density.
  {
    const random = rng(0x6a55)
    const kinds = ofGroup('grass')
    const allowed = kinds.map(f => onGround(math, terrainMaterial, mask, heights, f.name))
    const per = kinds.map(() => [])
    const total = kinds.reduce((sum, f) => sum + f.rule.density, 0)
    jitteredCandidates(random, { minX: -200, maxX: 200, minZ: -200, maxZ: 200 }, total, (x, z, r) => {
      if (!inValley(x, z) || inPlaza(x, z) || !clear(x, z) || heights.slopeAt(x, z) > 30) return false
      let pick = r() * total, k = 0
      while (k < kinds.length - 1 && pick > kinds[k].rule.density) { pick -= kinds[k].rule.density; k++ }
      if (!allowed[k](x, z)) return false
      per[k].push([x, z])
      return true
    })
    add(kinds, per, 0x6a60, 0.02)
  }
  // The undergrowth on the Forest Floor: only where the litter clearly wins, as the engine places it.
  {
    const random = rng(0xf0e5)
    const kinds = FOLIAGE_PROTOS.filter(f => f.surface === FOREST_SLOT)
    const surface = surfaceIndex(FOREST_SLOT)
    const allowed = kinds.map(f => onSurface(math, terrainMaterial, mask, heights, f.name, surface))
    const per = kinds.map(() => [])
    const total = kinds.reduce((sum, f) => sum + f.rule.density, 0)
    jitteredCandidates(random, { minX: -650, maxX: 650, minZ: -650, maxZ: 650 }, total, (x, z, r) => {
      // The mask first: most of the map has no litter, and the full surface test is the expensive one.
      if (sampleMask(mask, x, z, FOREST_CHANNEL) < 0.3 || !clear(x, z, 1) || inPlaza(x, z) || pathDistance(x, z) < 2) return false
      let pick = r() * total, k = 0
      while (k < kinds.length - 1 && pick > kinds[k].rule.density) { pick -= kinds[k].rule.density; k++ }
      if (!allowed[k](x, z)) return false
      per[k].push([x, z])
      return true
    })
    add(kinds, per, 0xf0f0, 0.05)
  }
  // Bushes on the ground: at the forest's edge, against the buildings and along the fences, a few in the open.
  {
    const random = rng(0xb05e)
    const kinds = ofGroup('bush')
    const allowed = kinds.map(f => onGround(math, terrainMaterial, mask, heights, f.name))
    const per = kinds.map(() => [])
    const fenceLines = FENCES.map(f => catmullRom(f, 1))
    const near = (d, inner, outer) => d < inner ? 0 : d > outer ? 0 : 1 - Math.abs(d - (inner + outer) / 2) / ((outer - inner) / 2)
    jitteredCandidates(random, { minX: -240, maxX: 240, minZ: -240, maxZ: 240 }, 0.08, (x, z, r) => {
      if (heights.heightAt(x, z) > 60 || inPlaza(x, z) || !clear(x, z, 1) || pathDistance(x, z) < 3 || heights.slopeAt(x, z) > 30) return false
      const edge = near(cliffDistance(x, z), 20, 50) * 0.5 + Math.min(1, sampleMask(mask, x, z, FOREST_CHANNEL) * 3) * 0.35
      const wall = Math.max(0, ...buildings.map(b => near(Math.hypot(x - b.x, z - b.z) - b.radius, 1.5, 6)))
      const fence = Math.max(0, ...fenceLines.map(l => near(distanceToPolyline(x, z, l), 0.8, 3.5)))
      const chance = Math.max(0.2, edge, wall * 0.8, fence * 0.8)
      if (r() > chance * 0.6) return false
      const k = Math.floor(r() * kinds.length)
      if (!allowed[k](x, z)) return false
      per[k].push([x, z])
      return true
    })
    add(kinds, per, 0xb060, 0.05)
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
      cullDistance: proto.cull,
      ...(proto.rule.castShadows ? { castShadows: true } : {}),
      ...(proto.rule.cameraDither ? { cameraDither: true } : {}),
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

// The player is the knight: its template is rebuilt around it (see knight.mjs), before anything below reads it.
const knight = buildKnight({ ROOT, BUILD, souls, idOf: id, node, vars, matJson, materialIds: KNIGHT_MATERIALS })
log('knight', knight.report)
LEVEL.player = souls.asTemplate('level:player', souls.playerNode(knight.playerModel), knight.textureIds)

// The Hollow and the Elite Knight are characters of their own (enemies.mjs); the other types keep the
// mannequin. The Elite Knight fights with the maul its model carried.
const hollow = buildHollow({ ROOT, PREPARED, souls, idOf: id, node, vars, matJson, materialIds: HOLLOW_MATERIALS })
log('hollow', hollow.report)
const strongKnight = buildStrongKnight({ ROOT, BUILD, souls, idOf: id, node, vars, matJson, materialIds: STRONG_KNIGHT_MATERIALS })
log('elite knight', strongKnight.report)
const ENEMY_MODELS = {
  Hollow: { placement: hollow.placement },
  'Elite Knight': {
    placement: strongKnight.placement,
    // The haft along +Y, the grip at the maul node's origin; its head's faces along the mesh's Z.
    weaponPart: souls.weaponPart('Strong Knight Maul', strongKnight.maul, STRONG_KNIGHT_MATERIALS[2]),
  },
}
const CHARACTER_MODELS = [knight.model, hollow.model, strongKnight.model]

/** The player's camera sees the far mountains: the Playable's 100 m far plane is a room's. */
const CAMERA_FAR = 3000
/** The player camera's boom length: where the player stands from the lens, so where depth of field focuses. */
/**
 * The player camera's boom: closer than the souls kit's 3.2 m, so the knight fills more of the frame and
 * the camera has less room to end up behind a wall or a trunk. Depth of field focuses here.
 */
const PLAYER_ARM = 2.4
/** The boom while locked on (SoulsLockOn.lockedArmLength): closer, so the fight fills the frame. */
const PLAYER_LOCKED_ARM = 1.6
if (!(() => {
  let found = false
  const walk = (n) => { if (n.type === 'cameraRig') found = true; (n.children ?? []).forEach(walk) }
  walk(LEVEL.player.nodeJson)
  return found
})()) throw new Error('the player template has no camera rig')

function widenCamera(json) {
  const walk = (n) => { if (n.type === 'camera' && n.camera) n.camera.far = CAMERA_FAR; (n.children ?? []).forEach(walk) }
  walk(json)
}
/**
 * The player's camera rig: on the shorter `PLAYER_ARM` (and closer still locked on), seeing through trees
 * and dungeon pillars instead of pulling in behind them — in a forest the retracting camera spent most of
 * its time jammed against a trunk. Only what opted in (`cameraDither` on the tree rules and the pillar
 * nodes) is cut; walls, ceilings and rocks still pull the camera in, as 'retract' does.
 */
function playerCamera(json) {
  const walk = (n) => {
    if (n.type === 'cameraRig') {
      n.armLength = PLAYER_ARM
      n.collisionMode = 'dither'; n.ditherRadius = 1.1; n.ditherStrength = 0.85
      // SoulsLockOn's framing while locked: in tight, over the shoulder.
      n.scriptVars = { ...(n.scriptVars ?? {}), lockedArmLength: PLAYER_LOCKED_ARM }
    }
    (n.children ?? []).forEach(walk)
  }
  walk(json)
}
// The template, its recorded source (what copies are checked against), and the placed copy all agree.
widenCamera(LEVEL.player.nodeJson)
widenCamera(souls.TEMPLATE_SOURCE.get(LEVEL.player.id))
playerCamera(LEVEL.player.nodeJson)
playerCamera(souls.TEMPLATE_SOURCE.get(LEVEL.player.id))

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
/**
 * Patrol loops along the roads, each walked by `hollows` (indices of their starting points). The points
 * are the path itself (a patrol walks straight between them), so each loop keeps to open road.
 */
const PATROLS = [
  { name: 'Pond Road', points: [[-12, 28], [8, 30], [26, 26], [20, 18], [0, 21]], hollows: [0, 2] },
  { name: 'Side Road', points: [[5, -8], [30, -26], [42, -30], [24, -16]], hollows: [1] },
  { name: 'Gate Road', points: [[-10, -18], [-4, -50], [-1, -78], [-9, -58], [-15, -30]], hollows: [1, 3] },
  { name: 'West Loop', points: [[-64, 14], [-72, 36], [-70, 62], [-62, 40]], hollows: [0] },
  { name: 'Windmill Track', points: [[50, -52], [36, -64], [18, -74], [30, -60]], hollows: [2] },
]

/**
 * Barrels stand in GROUPS of two or three against a wall, the way stores are stacked by a door, not
 * scattered round each building one by one. One group per building, two by the larger ones.
 */
function barrelSpots() {
  const out = []
  const random = rng(0xba22e1)
  const free = (x, z, gap) => heights.slopeAt(x, z) <= 14 && roadDistance(x, z) >= 3
    && !buildings.some(o => Math.hypot(x - o.x, z - o.z) < o.radius + 0.6)
    && out.every(([px, pz]) => Math.hypot(x - px, z - pz) >= gap)
  for (const b of buildings) {
    const groups = b.radius > 6 ? 2 : 1
    let made = 0
    for (let tries = 0; tries < 32 && made < groups; tries++) {
      // The group's anchor: just off the wall, and well apart from the building's other group.
      const a = random() * Math.PI * 2
      const r = b.radius + 1.1 + random() * 0.5
      const ax = b.x + Math.cos(a) * r, az = b.z + Math.sin(a) * r
      if (!free(ax, az, 4)) continue
      const group = [[ax, az]]
      const want = 2 + (random() < 0.5 ? 1 : 0)
      for (let k = 0; k < 12 && group.length < want; k++) {
        // Shoulder to shoulder: a barrel's width apart, along the wall more than away from it.
        const t = a + Math.PI / 2 * (random() < 0.5 ? 1 : -1)
        const [px, pz] = group[group.length - 1]
        const x = px + Math.cos(t) * (0.95 + random() * 0.25) + Math.cos(a) * (random() - 0.5) * 0.4
        const z = pz + Math.sin(t) * (0.95 + random() * 0.25) + Math.sin(a) * (random() - 0.5) * 0.4
        if (free(x, z, 0) && group.every(([gx, gz]) => Math.hypot(x - gx, z - gz) >= 0.9)) group.push([x, z])
      }
      if (group.length < 2) continue
      for (const [x, z] of group) out.push([x, z, Math.round(random() * 360)])
      made++
    }
  }
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
        maskRes: MASK_RES, maskSlices: MASK_SLICES,
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

/**
 * One probe for the whole valley: lighting and reflections for the hamlet, its houses and torches, and what
 * the pond's water reflects. Unbounded (size 0), so every surface in the valley takes it at full weight, with
 * no seam where one probe's box gives way to another's. Captured between the hamlet and the pond, and
 * re-captured as the day turns (ValleyDayNight).
 */
function valleyProbe() {
  const probe = souls.sourceNode('light probe')
  probe.name = 'Valley Probe'
  probe.id = id('valley:probe')
  probe.position = at((HAMLET.x + POND.x) / 2, (HAMLET.z + POND.z) / 2, 8)
  Object.assign(probe, { resolution: 256, mode: 'baked', intensity: 1, size: [0, 0, 0], blendDistance: 0 })
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
  const { surface, obstacles } = gather(root, { skip: n => souls.isMover(n) || n.body?.mass > 0 || HOUSE_WALLS.has(n) })
  // The houses: their walls carve, nothing of them is a surface — the floor inside is the terrain's.
  for (const [house, walls] of HOUSE_WALLS) {
    const wallsOnly = { ...house, children: [], body: { ...house.body, shapes: house.body.shapes.filter((_, i) => walls[i]) } }
    obstacles.push(...gather(wallsOnly).obstacles)
  }
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
 * about every 34 m), one beside the bonfire, and a wall torch on the buildings, on the wall that faces the
 * road. A building's wall is found by casting at its own mesh, at lamp height, from eight sides. Every lamp
 * keeps LAMP_SPACING from the others: pools of light with dark between them read as a night, and a cluster
 * of them only costs frame time.
 */
const LAMP_SPACING = 16
function valleyLamps(cavePair) {
  const out = []
  const spaced = (x, z) => out.every(l => Math.hypot(x - l.at[0], z - l.at[2]) > LAMP_SPACING)
  const clearOf = (x, z) => buildings.every(b => Math.hypot(x - b.x, z - b.z) > b.radius + 1)
    && Math.hypot(x - BONFIRE.x, z - BONFIRE.z) > 4 && spaced(x, z)
  // Road torches: from where the main road enters the hamlet to where it leaves it.
  const main = roadLines[0]
  let run = 0, side = 1
  for (let i = 1; i < main.length; i++) {
    const [ax, az] = main[i - 1], [bx, bz] = main[i]
    const len = Math.hypot(bx - ax, bz - az) || 1
    run += len
    if (az > 66 || az < 6 || run < 34) continue
    const nx = -(bz - az) / len, nz = (bx - ax) / len
    const x = bx + nx * 3.6 * side, z = bz + nz * 3.6 * side
    if (heights.slopeAt(x, z) > 18 || !clearOf(x, z)) continue
    out.push({ kind: 'torch', at: at(x, z, 0), yaw: 0 })
    run = 0
    side = -side
  }
  // The bonfire is a light of its own: one torch beside it, unless the road already put one near.
  for (const [dx, dz] of [[2.4, -2.6]]) if (spaced(BONFIRE.x + dx, BONFIRE.z + dz)) out.push({ kind: 'torch', at: at(BONFIRE.x + dx, BONFIRE.z + dz, 0), yaw: 0 })
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
    for (const h of hits) if (chosen.length < 1 && h.score > -0.2 && spaced(h.p[0], h.p[2])) chosen.push(h)
    for (const h of chosen) out.push({
      kind: 'wallTorch', at: [round3(h.p[0]), round3(h.p[1] - wallTorch.flame[1] + 0.3), round3(h.p[2])], yaw: Math.atan2(h.n[0], h.n[2]) * 180 / Math.PI,
    })
  }
  return [...cavePair.map(([x, z]) => ({ kind: 'torch', at: at(x, z, 0.6), yaw: 0 })), ...out]
}

// =====================================================================================================
// Exposure volumes
// =====================================================================================================
//
// The scene meters with the Day–Night preset everywhere; these trim it where the camera is. Each sets only
// the fields it changes, so the night curve and the adaptation speeds stay the scene's. The volume a camera
// is in is chosen by priority, then by size, so a house interior (priority 1) wins inside the village.

/** One exposure volume node, axis-aligned unless `yawDeg`. */
function exposureVolume(key, name, center, size, overrides, { priority = 0, blendDistance = 6, yawDeg = 0 } = {}) {
  return node(name, 'exposureVolume', {
    id: id(`exposure:${key}`), position: center.map(round3), rotation: [0, round3(yawDeg), 0],
    exposureVolume: { size: size.map(round3), blendDistance, priority, enabled: true, overrides },
  })
}

/** Ground heights over an x/z box, sampled on a grid: [min, max]. */
function groundRange(minX, maxX, minZ, maxZ, step = 4) {
  let lo = Infinity, hi = -Infinity
  for (let x = minX; x <= maxX; x += step) for (let z = minZ; z <= maxZ; z += step) {
    const h = heights.heightAt(x, z)
    lo = Math.min(lo, h); hi = Math.max(hi, h)
  }
  return [lo, hi]
}

/** An axis-aligned volume over an x/z box, from a little under its ground to `above` over its highest. */
function groundVolume(key, name, minX, maxX, minZ, maxZ, overrides, opts = {}, above = 25) {
  const [lo, hi] = groundRange(minX, maxX, minZ, maxZ)
  const y0 = lo - 3, y1 = hi + above
  return exposureVolume(key, name, [(minX + maxX) / 2, (y0 + y1) / 2, (minZ + maxZ) / 2],
    [maxX - minX, y1 - y0, maxZ - minZ], overrides, opts)
}

function exposureVolumes() {
  const out = []

  // The hamlet: every building but the windmill on its hill, and a street's width round them. Timber and
  // thatch under open sky: lifted a touch, so the village does not read as dark as the meadow it sits in.
  const village = buildings.filter(b => b.key !== 'windmill')
  const vMinX = Math.min(...village.map(b => b.x - b.radius)) - 10, vMaxX = Math.max(...village.map(b => b.x + b.radius)) + 10
  const vMinZ = Math.min(...village.map(b => b.z - b.radius)) - 10, vMaxZ = Math.max(...village.map(b => b.z + b.radius)) + 10
  out.push(groundVolume('village', 'Village Exposure', vMinX, vMaxX, vMinZ, vMaxZ,
    { exposureCompensation: 0.15 }, { blendDistance: 8 }))

  // The pond: open water throws the sky back, so hold the highlights a quarter stop down.
  const pondHalf = POND_HALF + 5
  out.push(exposureVolume('pond', 'Pond Exposure', [POND.x, POND_LEVEL + 5, POND.z], [pondHalf * 2, 16, pondHalf * 2],
    { exposureCompensation: -0.25 }, { blendDistance: 5 }))

  // The forests: wherever the trees stand thick, on a 40 m grid, merged into rectangles. Under the canopy
  // the meter reads the bright gaps, so lift a third of a stop and let it adapt a little further down.
  const CELL = 40, MIN_TREES = 10
  const counts = new Map()
  for (const [x, z] of TREE_POINTS) {
    if (Math.abs(x) > 260 || Math.abs(z) > 260) continue
    const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const hot = new Set([...counts].filter(([, n]) => n >= MIN_TREES).map(([k]) => k))
  const used = new Set()
  let forests = 0
  for (const k of [...hot].sort()) {
    if (used.has(k)) continue
    const [gx, gz] = k.split(',').map(Number)
    // Greedy: as far along +x as the run of hot cells goes, then as many rows of that run in +z.
    let w = 1
    while (hot.has(`${gx + w},${gz}`) && !used.has(`${gx + w},${gz}`)) w++
    let h = 1
    grow: for (;;) {
      for (let i = 0; i < w; i++) if (!hot.has(`${gx + i},${gz + h}`) || used.has(`${gx + i},${gz + h}`)) break grow
      h++
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) used.add(`${gx + i},${gz + j}`)
    out.push(groundVolume(`forest:${forests}`, `Forest Exposure ${++forests}`,
      gx * CELL, (gx + w) * CELL, gz * CELL, (gz + h) * CELL,
      { exposureCompensation: 0.35 }, { blendDistance: 10 }, 30))
  }

  // Inside each enterable house: lamp-lit and windowed, so the Interior preset's lift and its quicker
  // adaptation. Priority 1, so it wins over the village round it.
  for (const b of buildings) {
    const house = houseShapes.get(b.key)
    if (!house?.interior) continue
    const yawDeg = b.yaw * 180 / Math.PI
    out.push(exposureVolume(`interior:${b.key}`, `${b.prop.name} Interior Exposure`, buildingToWorld(b, house.interior.center),
      house.interior.size, { exposureCompensation: 0.5, exposureSpeedUp: 2.5, exposureSpeedDown: 1.5 },
      { priority: 1, blendDistance: 1.5, yawDeg }))
  }
  log('exposure volumes', `village, pond, ${forests} forest, ${out.length - 2 - forests} interior`)
  return out
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
    // Distance fog only past 300 m: the valley reads clear, and only its far ridges go into the air.
    fogEnabled: true, fogDensity: 0.0004, fogStart: 300, fogMaxOpacity: 0.5,
    nightEnabled: true, starIntensity: 1.6, starDensity: 0.6, airglowIntensity: 0.8,
    moonEnabled: true, moonSize: 2.4, moonPhase: 1, moonOffsetYaw: 20, moonOffsetPitch: 22, moonColor: [0.74, 0.82, 1], moonIntensity: 1.3,
    moonlightIntensity: 0.02,
  }
  const clouds = souls.sourceNode('volumetric clouds')
  clouds.id = id('clouds')
  // The preset sets the look; the clouds follow the Wind node below (useSceneWind), so its wind direction is unused.
  // More cloud than Sunny's scattered puffs, lit softer: a weaker silver lining and forward lobe, so the
  // clouds round the sun do not burn white when you look up.
  clouds.clouds = { ...clouds.clouds, ...PRESETS.clouds, coverage: 0.5, silverIntensity: 0.3, phaseG: 0.4, sunIntensity: 9, useSceneWind: true }
  // One wind for the whole valley: the grass and pines sway with it, and the clouds drift the same way.
  // The fade distances are the foliage's performance budget, not a look, so they stay the valley's.
  const wind = node('Wind', 'wind', {
    id: id('wind'),
    wind: { direction: WIND_DIRECTION, ...PRESETS.wind, fadeStart: 35, fadeEnd: 70 },
  })
  // Lights the valley with its own sky, and lets the clouds' shadows sweep across it. At night the flat
  // The flat ambient (VALLEY_AMBIENT, a daylight fill) falls to about a lux with the sun (nightAmbient), so
  // the moon and the torches carry the night. Anything more and the metering lifts the night to a grey day.
  const skyLight = node('Sky Light', 'skyLight', { id: id('skylight'), skyLight: { cloudShadows: true, nightAmbient: 0.0001 } })
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
    // Hollows on patrol, walking the roads' loops (the Nav Mesh's routes) until something comes into sight.
    ...PATROLS.flatMap((route, r) => route.hollows.map((start, k) => {
      const [x, z] = route.points[start]
      return souls.placedSpawn(`patrol-${r}-${k}`, `Spawn Patrol ${route.name} ${k + 1}`, at(x, z), 0,
        { templateName: 'Hollow', patrolRoute: route.name })
    })),
    // The landmarks are held by the heavies: the hamlet's well, the windmill, and the gate's approach.
    souls.placedSpawn('well-knight', 'Spawn Hamlet Knight', at(HAMLET.x + 2, HAMLET.z + 4), 160, { templateName: 'Elite Knight' }),
    souls.placedSpawn('mill-knight', 'Spawn Windmill Knight', at(WATCHTOWER.x - 9, WATCHTOWER.z - 2), 250, { templateName: 'Elite Knight' }),
    souls.placedSpawn('gate-knight', 'Spawn Gate Knight', at(-3, -108), 0, { templateName: 'Elite Knight' }),
    souls.placedSpawn('gate-hollow', 'Spawn Gate Hollow', at(4, -104), 340, { templateName: 'Hollow' }),
    souls.placedSpawn('mill-caster', 'Spawn Windmill Sorcerer', at(WATCHTOWER.x + 6, WATCHTOWER.z + 9), 200, { templateName: 'Hollow Sorcerer' }),
  ])

  // Torches either side of the cave's mouth, down the road through the hamlet and on its walls: by day you
  // hardly see them, by night they carry the valley.
  const lamps = valleyLamps([[-6.5, notchZ + 2], [6.5, notchZ + 2]])
  log('lamps', `${lamps.filter(l => l.kind === 'torch').length} standing, ${lamps.filter(l => l.kind === 'wallTorch').length} on walls`)
  const torches = souls.group('torches', 'Torches', lamps.map((l, i) =>
    placeFire(l.kind, `valley:${i}`, l.at, [0, Math.round(l.yaw * 100) / 100, 0])))

  const player = souls.playerNode(knight.playerModel)
  widenCamera(player)
  playerCamera(player)
  player.position = at(SPAWN.x, SPAWN.z)
  player.rotation = [0, SPAWN.yawDeg, 0]

  // Bounded to the valley (the cliffs bound it anyway), so an editor bake stays inside the play area.
  const navMesh = node('Nav Mesh', 'navMesh', {
    id: id('navmesh'), position: [0, 20, -20], bake: {}, agentRadius: 0.45, size: [300, 80, 260],
    routes: PATROLS.map(r => ({ name: r.name, loop: true, points: r.points.map(([x, z]) => at(x, z, 0.05)) })),
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
      souls.group('water', 'Water', [pondWater(), pondVolume(), pondZone(), ...floaters()]),
      valleyProbe(),
      souls.group('buildings', 'Buildings', placedBuildings),
      souls.group('occluders', 'Occluders', buildingOccluders()),
      souls.group('exposure-volumes', 'Exposure Volumes', exposureVolumes()),
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
    // The High quality tier (SSIL, motion blur, TAA, bloom), the Day–Night metered exposure, the
    // Cinematic lens look, and Cinematic depth of field focused where the camera boom puts the player.
    quality: 'high', motionBlurEnabled: true,
    ...PRESETS.exposure, ...PRESETS.look, ...PRESETS.dof, dofFocusDistance: PLAYER_ARM,
    // Where metering starts before its first sample, and what a host that cannot meter shows: noon.
    exposure: REFERENCE_ILLUMINANCE / (1.2 * 2 ** 15),
    // The torches' cube shadows, for the nearest four: what makes the hamlet's night.
    pointShadowsEnabled: true, pointShadowResolution: 512, pointShadowDistance: 40,
    foliageCullDistance: TREE_CULL, foliageCellSize: 13,
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
  playerModel: knight.playerModel,
  id, node, vars, souls, withScript, linkInstance, tex, pbrMaterial, libraryMaterial, modelNode, matJson, texIdsOf, log,
  placeFire, wallTorch, brazierCage, campfire, CAMPFIRE_MATS, CAGE_MAT, CAVE_DARK_MAT, SURFACES, rayHit,
  BARREL_TEMPLATE, breakableBarrelNode, mossRocks, MOSS_ROCK_MAT,
  ROOT, BUILD, PROPS, PROJECT_NAME, PRESETS, PLAYER_ARM, widenCamera, playerCamera, REFERENCE_ILLUMINANCE, ASSET_HASH_VERSION,
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
    description: 'A souls-like on a 2 km mountain valley with a day and night cycle: stamina combat, rolls, lock-on, bonfires and Estus, on landscape layers for ground, rock, snow, forest floor and trails, meadow grass, pine and spruce forest and bushes made with the Foliage Creator, a torch-lit hamlet with breakable barrels, and a skull cave down into a three-level dungeon with a boss in its throne arena.',
    order: 0,
  },
  models: [...CHARACTER_MODELS, ...propAssets, ...foliageAssets, ...dungeon.models],
  rigs: [knight.rig, hollow.rig, strongKnight.rig],
  enemyModels: ENEMY_MODELS,
  templates: [BARREL_TEMPLATE, DEBRIS_TEMPLATE, CAVE_TEMPLATE, ...Object.values(FIRE_TEMPLATES)],
  excludeTemplates: [LEVEL.torch.id, LEVEL.bonfire.id],
  tilesets: [FIRE_TILESET],
  extraScenes: [{ id: DUNGEON_ID, name: DUNGEON_NAME, build: dungeon.scene, refs: { modelIds: [souls.MANNEQUIN_MODEL, ...CHARACTER_MODELS.map(a => a.id), ...dungeon.models.map(a => a.id)] } }],
  // 2 km of valley: barrels, debris and enemies far from the camera freeze in place instead of
  // simulating against the terrain. The player opts out (simulationMode 'always').
  projectSettings: { engine: { simulationRange: 90 } },
  // A message's glyph is tuned for Hollow Keep's dusk exposure; under the valley's noon it burned white. It
  // takes a tenth of the exposure (GLOW_EXPOSURE_WEIGHT), so this is how it reads at noon, a little hotter
  // at night and underground.
  materialOverrides: { [souls.MAT.glyph]: { emissiveIntensity: 2.2 } },
  terrainMaterials: [{ id: TERRAIN_MATERIAL_ID, name: 'Valley Landscape', material: terrainMaterial, textureIds: [...new Set(Object.values(TERRAIN_TEX).flatMap(t => Object.values(t)))] }],
  folders: {
    scene: { [PROJECT_NAME]: '/Scenes', [DUNGEON_NAME]: '/Scenes' },
    template: {
      'Breakable Barrel': BARREL_DIR, 'Barrel Debris': BARREL_DIR, 'Skull Cave Entrance': CAVE_DIR,
      // At the feature's root, as every other template is.
      ...Object.fromEntries(Object.values(FIRE_TEMPLATES).map(t => [t.name, FIRE])),
    },
    tileset: { Fire: FIRE },
    model: {
      ...foliageFolder, ...buildingFolder, ...dungeon.folders, Knight: `${KNIGHT_DIR}/Models`,
      Hollow: `${HOLLOW_DIR}/Models`, 'Strong Knight': `${ELITE_DIR}/Models`,
    },
    rig: { Knight: `${KNIGHT_DIR}/Rigs`, Hollow: `${HOLLOW_DIR}/Rigs`, 'Strong Knight': `${ELITE_DIR}/Rigs` },
    // The souls torch and bonfire are excluded (the valley's fires replace them); what they leave in the
    // libraries joins the valley's fires rather than keeping a folder each.
    particleSystem: {
      'Torch Embers': `${FIRE}/Particles`, 'Hearth Embers': `${FIRE}/Particles`,
      'Torch Fire': `${FIRE}/Particles`, 'Bonfire Fire': `${FIRE}/Particles`,
    },
    material: {
      ...materialFolder,
      'Bonfire Ash (placeholder)': `${FIRE}/Materials`,
      'Dark Stone (placeholder)': SHARED_PROPS, 'Wood (placeholder)': SHARED_PROPS, 'Iron (placeholder)': SHARED_PROPS,
    },
    terrainMaterial: { 'Valley Landscape': LANDSCAPE },
    script: { 'Windmill Sails': `${BUILDINGS}/Scripts`, 'Fire Light': `${FIRE}/Scripts`, Bonfire: `${FIRE}/Scripts`, 'Day and Night': '/Environment/Scripts' },
  },
  textureEntries: TEXTURE_ENTRIES,
  refs: {
    modelIds: [souls.MANNEQUIN_MODEL, ...CHARACTER_MODELS.map(a => a.id), ...propAssets.map(a => a.id), ...foliageAssets.map(a => a.id)],
    terrainMaterialIds: [TERRAIN_MATERIAL_ID],
    foliageModelIds: foliageAssets.map(a => a.id),
  },
  excludeMaterials,
  hashKinds: [['terrainMaterial', 'terrainMaterials']],
})

const sceneFile = path.join(OUT, 'scenes', `${SCENE_ID}.json`)
const sceneBytes = fs.statSync(sceneFile).size
// Format 1 is what writeProject can author; format 2 is what can be checked in. Every plant's levels are
// stored in the model library, the terrain material and the scene's foliage layer as decimal text;
// packing interns them once, as binary, in split parts, under GitHub's 100 MB file limit.
const largest = await packFormat2(OUT)
log(`${PROJECT_NAME} written to applications/editor/public/examples/valley/`)
log(`  templates ${result.templates} · materials ${result.materials} · textures ${result.textureCount} · scene ${mb(sceneBytes)} unpacked · largest file ${mb(largest)}`)
log('Next:  npm --prefix editor run examples:list')
