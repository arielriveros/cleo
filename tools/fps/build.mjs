#!/usr/bin/env node
// "Firing Line": a first-person shooter built from the Mixamo bots, their 49 rifle-pack clips and the three
// animated weapon GLBs in build/, on a primitive-built arena. Writes the project folder the editor imports:
//
//     node tools/fps/prepareCharacters.mjs        # once: the four FBX characters (~5 min)
//     python tools/fps/prepareTextures.py         # once: their maps
//     node tools/fps/prepareWeapons.mjs           # once: the weapon GLBs
//     node tools/fps/importClips.mjs              # once, or when the clip set changes: fpsClips.json (committed)
//     node tools/fps/build.mjs [out-dir]          # default applications/editor/public/examples/firing-line
//
// ## The game is the templates
//
// Nothing about the match lives in the arena. The scripts and templates (FPS Game Manager, FPS Player, the
// bots, Spawn Point, Cover Point, the effects) are scene-independent; a scene holds a Game Manager and
// whatever fighters it wants, and plays. The arena here is one scene's dressing; `Minimal` is the same game on
// four boxes. See docs/editor/fps-example.md.
//
//   Firing Line - 1v3   the player against three bots
//   Firing Line - 2v2   the player and a bot against two
//   Firing Line - FFA   four fighters, every one for itself
//   Minimal             a Game Manager (free for all), the player and two bots, on a few boxes

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { mat4, quat, vec3 } from 'gl-matrix'
import { headlessNavBaker } from '../navBakeHeadless.mjs'
import { ASSET_HASH_VERSION, KIND_EXT, SCENE_REFS_VERSION } from '../exampleKit/editorConstants.mjs'
import { packFormat2 } from '../exampleKit/packFormat2.mjs'
import { writeJson, mb } from '../exampleKit/bundle.mjs'
import {
  ACCENT, CREATED_AT, DIM, HERE, INK, PROJECT_NAME, ROOT, asTemplate, assetHashKey, bar, burst, bounceOff, clone, emitter, fade, group, hashAsset,
  linkInstance, material, materials, matJson, mod, node, panel, particleSystems, particles, pbr, pointLight, prop, readJson, rect, round3, screenRoot,
  scripts, seedScene, sourceNode, stableId, stretch, soundsGroup, text, textures, uiNode, variantTemplate, vars, vfx, walkSize, withScript,
} from './kit.mjs'
import { FPS_INPUT_MAP } from './inputMap.mjs'
import { bulletHole } from './pngs.mjs'
import {
  BOT_KEYS, VIEWMODELS, animations, botController, buildBot, buildViewmodel, clipRig, eulerFromQuat, fields,
} from './characters.mjs'
import { MAT, arenaLevel } from './level.mjs'

const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'applications', 'editor', 'public', 'examples', 'firing-line'))
const PRESETS = readJson(path.join(HERE, 'presets.json'))
const log = (what, detail) => console.log(`  ${what.padEnd(14)} ${detail}`)

// =====================================================================================================
// Characters and viewmodels
// =====================================================================================================

// The AK first: its sleeves and gloves are the smallest of the three files', and the arms are shared.
const viewmodels = Object.fromEntries(['ak47', 'pistol', 'shotgun'].map(k => [k, buildViewmodel(k)]))
for (const [k, v] of Object.entries(viewmodels)) log(`viewmodel ${k}`, v.report)
const bots = Object.fromEntries(BOT_KEYS.map(k => [k, buildBot(k)]))
for (const [k, b] of Object.entries(bots)) log(`bot ${k}`, b.report)

// =====================================================================================================
// Effects
// =====================================================================================================

const FX = {
  flash: vfx('muzzle-flash', 'Muzzle Flash', [
    emitter('flash-core', 'Core', {
      capacity: 16, looping: false, duration: 0.2,
      spawn: [mod('spawnRate', { rate: 0 }), burst(3)],
      init: [mod('shape', { shape: 'cone', radius: 0.01, angle: 8, thickness: 1 }), mod('lifetime', { range: [0.035, 0.06] }),
        mod('velocity', { mode: 'shape', speed: [0.5, 1.5] }), mod('size', { range: [0.28, 0.42] }), mod('rotation', { angle: [0, 360], spin: [0, 0] }),
        mod('color', { mode: 'constant', colorA: [1, 0.78, 0.4, 1], intensity: 16 })],
      update: [mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', softness: 0 },
    }),
    emitter('flash-sparks', 'Sparks', {
      capacity: 32, looping: false, duration: 0.2,
      spawn: [mod('spawnRate', { rate: 0 }), burst(10)],
      init: [mod('shape', { shape: 'cone', radius: 0.015, angle: 16, thickness: 1 }), mod('lifetime', { range: [0.08, 0.2] }),
        mod('velocity', { mode: 'shape', speed: [5, 12] }), mod('size', { range: [0.012, 0.028] }),
        mod('color', { mode: 'constant', colorA: [1, 0.7, 0.25, 1], intensity: 14 })],
      update: [mod('drag', { coefficient: 1 }), mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', alignment: 'velocity', stretch: 1.4, softness: 0 },
    }),
    emitter('flash-smoke', 'Smoke', {
      capacity: 16, looping: false, duration: 1,
      spawn: [mod('spawnRate', { rate: 0 }), burst(3)],
      init: [mod('shape', { shape: 'cone', radius: 0.02, angle: 12, thickness: 1 }), mod('lifetime', { range: [0.5, 0.9] }),
        mod('velocity', { mode: 'shape', speed: [0.4, 1.1] }), mod('size', { range: [0.1, 0.18] }), mod('rotation', { angle: [0, 360], spin: [-40, 40] }),
        mod('color', { mode: 'constant', colorA: [0.62, 0.6, 0.57, 0.25] })],
      update: [mod('drag', { coefficient: 1.2 }), mod('colorOverLife', { gradient: fade(0.5) }), mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.5 }, { t: 1, v: 2.2 }] } })],
      render: { lit: true, softness: 0.6 },
    }),
  ], { center: [0, 0, 0.5], extents: [1, 1, 1.5] }),
  impact: vfx('impact', 'Bullet Impact', [
    emitter('impact-sparks', 'Sparks', {
      capacity: 48, looping: false, duration: 1,
      spawn: [mod('spawnRate', { rate: 0 }), burst(14)],
      init: [mod('shape', { shape: 'cone', radius: 0.01, angle: 55, thickness: 1 }), mod('lifetime', { range: [0.25, 0.7] }),
        mod('velocity', { mode: 'shape', speed: [2, 6] }), mod('size', { range: [0.008, 0.02] }),
        mod('color', { mode: 'constant', colorA: [1, 0.62, 0.2, 1], intensity: 12 })],
      update: [mod('gravity', { scale: 1 }), mod('drag', { coefficient: 0.4 }), bounceOff(0.4, 0.3), mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'additive', alignment: 'velocity', stretch: 0.9, softness: 0 },
    }),
    emitter('impact-dust', 'Dust', {
      capacity: 24, looping: false, duration: 1.5,
      spawn: [mod('spawnRate', { rate: 0 }), burst(7)],
      init: [mod('shape', { shape: 'cone', radius: 0.03, angle: 40, thickness: 1 }), mod('lifetime', { range: [0.5, 1.0] }),
        mod('velocity', { mode: 'shape', speed: [0.3, 1.2] }), mod('size', { range: [0.12, 0.22] }), mod('rotation', { angle: [0, 360], spin: [-30, 30] }),
        mod('color', { mode: 'constant', colorA: [0.55, 0.52, 0.48, 0.32] })],
      update: [mod('drag', { coefficient: 1.5 }), mod('colorOverLife', { gradient: fade(0.6) }), mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.5 }, { t: 1, v: 2 }] } })],
      render: { lit: true, softness: 0.6 },
    }),
  ], { center: [0, 0.3, 0], extents: [1.5, 1.5, 1.5] }),
  blood: vfx('blood-hit', 'Blood Hit', [
    emitter('blood-droplets', 'Droplets', {
      capacity: 48, looping: false, duration: 1,
      spawn: [mod('spawnRate', { rate: 0 }), burst(18)],
      init: [mod('shape', { shape: 'sphere', radius: 0.05, thickness: 1 }), mod('lifetime', { range: [0.3, 0.7] }),
        mod('velocity', { mode: 'radial', speed: [0.8, 3.2] }), mod('size', { range: [0.014, 0.034] }),
        mod('color', { mode: 'constant', colorA: [0.3, 0.012, 0.012, 1], intensity: 1 })],
      update: [mod('gravity', { scale: 1.6 }), mod('drag', { coefficient: 0.5 }), mod('colorOverLife', { gradient: fade(1) })],
      render: { blend: 'alpha', alignment: 'velocity', stretch: 0.4, softness: 0 },
    }),
    emitter('blood-mist', 'Mist', {
      capacity: 12, looping: false, duration: 1,
      spawn: [mod('spawnRate', { rate: 0 }), burst(4)],
      init: [mod('shape', { shape: 'sphere', radius: 0.04, thickness: 1 }), mod('lifetime', { range: [0.3, 0.55] }),
        mod('velocity', { mode: 'radial', speed: [0.2, 0.8] }), mod('size', { range: [0.1, 0.18] }),
        mod('color', { mode: 'constant', colorA: [0.4, 0.02, 0.02, 0.35] })],
      update: [mod('colorOverLife', { gradient: fade(0.6) }), mod('sizeOverLife', { curve: { keys: [{ t: 0, v: 0.6 }, { t: 1, v: 1.8 }] } })],
      render: { lit: true, softness: 0.5 },
    }),
  ], { center: [0, 0, 0], extents: [1.2, 1.2, 1.2] }),
}

const HOLE_TEX = textures.addBytes(stableId('texture:bullet-hole'), bulletHole(0x4401), { wrapping: 'clamp', mipMap: true })
const HOLE_MAT = material('fx:bullet-hole', 'Bullet Hole', pbr([1, 1, 1], { roughness: 0.9, castShadow: false, textures: { baseColorTexture: HOLE_TEX } }), [HOLE_TEX])
const TRACER_MAT = material('fx:tracer', 'Tracer', pbr([1, 0.85, 0.5], { emissive: [1, 0.78, 0.4], emissiveIntensity: 40, emissiveExposureWeight: 1, castShadow: false }))

/** An effect template root: the script that runs its lifetime, and what the effect is made of. */
function fxRoot(key, name, lifetime, children, scriptVars = {}) {
  return withScript(group(`fx:${key}`, name, children), 'FpsFx', { lifetime, ...scriptVars })
}

const flashTemplate = () => fxRoot('flash', 'FPS Muzzle Flash', 0.7, [
  particles('flash:ps', 'Flash', FX.flash, { rotation: [90, 0, 0] }),
  pointLight('flash:light', 'Light', [1, 0.72, 0.4], 9000, 9, [0, 0, 0.15]),
], { lightFalloff: 4 })
const impactTemplate = () => fxRoot('impact', 'FPS Impact', 1.6, [particles('impact:ps', 'Impact', FX.impact)])
const bloodTemplate = () => fxRoot('blood', 'FPS Blood Hit', 1.2, [particles('blood:ps', 'Blood', FX.blood)])
const holeTemplate = () => withScript(group('fx:hole', 'FPS Bullet Hole', [
  node('Hole', 'decal', {
    id: stableId('decal:hole'),
    variables: vars({ __materialId: HOLE_MAT }),
    decal: {
      size: [0.16, 0.5, 0.16], opacity: 1, sortOrder: 0, angleFade: 0.3, depthFade: 0.3,
      affects: { albedo: true, normal: false, surface: true, emissive: false }, receivers: 'all', pattern: 'material', material: matJson(HOLE_MAT),
    },
  }),
]), 'FpsDecal')
const tracerTemplate = () => withScript(group('fx:tracer', 'FPS Tracer', [
  prop('tracer:mesh', 'Streak', 'box', TRACER_MAT, { position: [0, 0, -3], scale: [0.018, 0.018, 6] }),
]), 'FpsTracer')

// =====================================================================================================
// Characters: the templates
// =====================================================================================================

const COMBAT_CUES = ['Shot', 'Hurt', 'Death']
const capsuleBody = (radius, height, mass) => ({
  ...clone(sourceNode('Playable').body), mass, restitution: 0, friction: 0, linearDamping: 0,
  angularConstraints: [0, 0, 0], linearConstraints: [1, 1, 1], groundProbeDistance: 0.12,
  shapes: [{ type: 'capsule', radius, height, numSegments: 16, offset: [0, height / 2, 0], rotation: [0, 0, 0] }],
})

// ----- the player ---------------------------------------------------------------------------------

function hud() {
  const C = [0.5, 0.5], BL = [0, 1], BR = [1, 1], TC = [0.5, 0], TR = [1, 0], BC = [0.5, 1]
  const bar2 = (key, name, r, tint) => panel(`hud:${key}`, name, r, tint)
  const arm = (name, r) => bar2(`cross:${name}`, name, r, [1, 1, 1, 0.92])
  const edge = (name, anchorMin, anchorMax, min, max) => panel(`hud:${name}`, name, { anchorMin, anchorMax, offsetMin: min, offsetMax: max }, [0.8, 0.03, 0.03, 0.55], [], { ui: { opacity: 0 } })
  return withScript(screenRoot('HUD', 'hud', [
    // The vignette: red edges that come up as health falls.
    panel('hud:vignette', 'Vignette', stretch(0), [0, 0, 0, 0], [
      panel('hud:vig:t', 'VigTop', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [0, 0], offsetMax: [0, 120] }, [0.5, 0, 0, 0.22]),
      panel('hud:vig:b', 'VigBottom', { anchorMin: [0, 1], anchorMax: [1, 1], offsetMin: [0, -120], offsetMax: [0, 0] }, [0.5, 0, 0, 0.22]),
      panel('hud:vig:l', 'VigLeft', { anchorMin: [0, 0], anchorMax: [0, 1], offsetMin: [0, 0], offsetMax: [140, 0] }, [0.5, 0, 0, 0.22]),
      panel('hud:vig:r', 'VigRight', { anchorMin: [1, 0], anchorMax: [1, 1], offsetMin: [-140, 0], offsetMax: [0, 0] }, [0.5, 0, 0, 0.22]),
    ], { ui: { opacity: 0 } }),
    // Where damage came from.
    edge('HitFront', [0.3, 0], [0.7, 0], [0, 0], [0, 54]),
    edge('HitBack', [0.3, 1], [0.7, 1], [0, -54], [0, 0]),
    edge('HitLeft', [0, 0.3], [0, 0.7], [0, 0], [54, 0]),
    edge('HitRight', [1, 0.3], [1, 0.7], [-54, 0], [0, 0]),
    // The crosshair: four arms and a dot, opened by the weapon's spread.
    panel('hud:crosshair', 'Crosshair', stretch(0), [0, 0, 0, 0], [
      arm('CrossTop', rect(C, [-1, -14], [1, -5])), arm('CrossBottom', rect(C, [-1, 5], [1, 14])),
      arm('CrossLeft', rect(C, [-14, -1], [-5, 1])), arm('CrossRight', rect(C, [5, -1], [14, 1])),
      panel('hud:cross:dot', 'CrossDot', rect(C, [-1, -1], [1, 1]), [1, 1, 1, 0.95]),
    ]),
    panel('hud:hit', 'HitMarker', rect(C, [-12, -12], [12, 12]), [0, 0, 0, 0], [
      panel('hud:hit:a', 'HitA', { ...rect(C, [-11, -1], [11, 1]), rotationDeg: 45, pivot: [0.5, 0.5] }, [1, 1, 1, 1]),
      panel('hud:hit:b', 'HitB', { ...rect(C, [-11, -1], [11, 1]), rotationDeg: -45, pivot: [0.5, 0.5] }, [1, 1, 1, 1]),
    ], { visible: false }),
    panel('hud:hitkill', 'HitMarkerKill', rect(C, [-16, -16], [16, 16]), [0, 0, 0, 0], [
      panel('hud:hitkill:a', 'KillA', { ...rect(C, [-15, -1.5], [15, 1.5]), rotationDeg: 45, pivot: [0.5, 0.5] }, [1, 0.15, 0.1, 1]),
      panel('hud:hitkill:b', 'KillB', { ...rect(C, [-15, -1.5], [15, 1.5]), rotationDeg: -45, pivot: [0.5, 0.5] }, [1, 0.15, 0.1, 1]),
    ], { visible: false }),
    // Health, bottom left.
    panel('hud:health-back', 'HealthBack', rect(BL, [56, -84], [356, -64]), [0, 0, 0, 0.5]),
    bar('hud:health', 'Health', rect(BL, [56, -84], [356, -64]), [0.82, 0.86, 0.9, 1], [0, 0, 0, 0], 0.05, 2),
    text('hud:health-text', 'HealthText', '100', rect(BL, [56, -140], [200, -90]), { size: 46, weight: 700 }),
    // The weapon, bottom right.
    panel('hud:ammunition', 'Ammunition', rect(BR, [-420, -150], [-40, -40]), [0, 0, 0, 0], [
      text('hud:ammo', 'Ammo', '30', { anchorMin: [0, 0], anchorMax: [0, 1], offsetMin: [0, 0], offsetMax: [200, 0] }, { size: 76, weight: 700, align: 'right' }),
      text('hud:reserve', 'Reserve', '/ 150', { anchorMin: [0, 0], anchorMax: [0, 1], offsetMin: [206, 22], offsetMax: [340, 0] }, { size: 30, tint: DIM, align: 'left', vAlign: 'bottom' }),
      text('hud:weapon', 'WeaponName', 'AK-47', { anchorMin: [0, 0], anchorMax: [1, 0], offsetMin: [0, -34], offsetMax: [0, 0] }, { size: 22, tint: DIM, align: 'right', weight: 600 }),
    ]),
    text('hud:reloading', 'Reloading', '', rect(BC, [-300, -250], [300, -200]), { size: 28, tint: ACCENT, align: 'center', weight: 700 }),
    // The match, top.
    text('hud:score', 'Score', '', rect(TC, [-420, 26], [420, 74]), { size: 36, align: 'center', weight: 700 }),
    text('hud:timer', 'Timer', '', rect(TC, [-200, 76], [200, 112]), { size: 26, align: 'center', tint: DIM }),
    text('hud:mode', 'Mode', '', rect(TC, [-300, 112], [300, 140]), { size: 20, align: 'center', tint: DIM }),
    text('hud:feed', 'Feed', '', rect(TR, [-600, 28], [-96, 220]), { size: 22, align: 'right', vAlign: 'top', tint: INK, lineHeight: 1.35 }),
    text('hud:message', 'Message', '', rect(C, [-600, -170], [600, -70]), { size: 84, align: 'center', weight: 800, tint: [0.9, 0.18, 0.12, 1] }),
    text('hud:submessage', 'SubMessage', '', rect(C, [-500, -64], [500, -20]), { size: 30, align: 'center', tint: INK }),
  ]), 'FpsHud')
}

function playerNode() {
  const player = sourceNode('Playable')
  player.name = 'FPS Player'
  player.id = stableId('player')
  player.position = [0, 0.05, 0]
  player.rotation = [0, 0, 0]
  player.variables = {}
  delete player.script
  player.body = { ...capsuleBody(0.3, 1.78, 75), simulationMode: 'always' }
  Object.assign(player, {
    walkSpeed: 3.7, runSpeed: 6.2, turnSpeed: 720, turnThreshold: 170, acceleration: 38, airControl: 0.35,
    facingMode: 'aim', directionSmoothing: 0.1, jumpSpeed: 4.3, coyoteSeconds: 0.1,
  })

  const rig = player.children.find(c => c.name === 'camera rig')
  rig.id = stableId('player:rig')
  rig.name = 'Camera Rig'
  rig.variables = {}
  delete rig.script
  // The "First-Person" camera-rig preset (cameraRigPresets.ts): on the target's eye, no boom, no collision.
  Object.assign(rig, {
    position: [0, 1.66, 0], followId: player.id, lookAtId: null, aimMode: 'orbit', armLength: 0, socketOffset: [0, 0, 0],
    followOffset: [0, 1.66, 0], followSpace: 'world', followDamping: [0, 0, 0], followDampingSpace: 'world', lookAtOffset: [0, 0, 0],
    pitchMin: -85, pitchMax: 85, pitch: 0, yaw: 0, collisionEnabled: false, fovEnabled: true, fov: 78, fovDamping: 0,
    yawSensitivity: 0.1, pitchSensitivity: 0.1, aimDamping: 0,
  })
  const camera = rig.children[0]
  camera.id = stableId('player:camera')
  // The viewmodels are drawn through this lens whatever the world's field of view (Node.viewmodel), and the
  // arms start close to the eye: a near plane to match.
  camera.camera = { ...camera.camera, near: 0.05, viewmodelFov: 58 }
  camera.children = [group('viewmodels', 'Viewmodels', ['ak47', 'pistol', 'shotgun'].map(k => {
    const n = clone(viewmodels[k].nodeJson)
    n.viewmodel = true
    n.motionBlur = 'none'
    return n
  }))]
  rig.children = [camera]

  const controller = node('Player Controller', 'controller', {
    id: stableId('player:controller'), possessedId: player.id, aimSourceId: null, controlSource: 'player',
    moveAction: 'Move', lookAction: 'Look', jumpAction: 'Jump', sprintAction: 'Sprint', crouchAction: 'Crouch',
    aimSource: 'possessed', driveAimTarget: true,
  })
  player.children = [rig, hud(), soundsGroup('player', ['Equip', 'Reload', 'Empty', 'ShotPistol', 'ShotRifle', 'ShotShotgun', 'Hurt', 'Death', 'Hit', 'Kill']), controller]
  return withScript(player, 'FpsPlayer', {})
}

// ----- the bots -----------------------------------------------------------------------------------

/** A bot's brain: a three-state graph over the one number the script publishes (FpsBot.navMode). */
function botBrainMachine() {
  const leaf = (param, op, value) => ({ param, op, value })
  const all = (...c) => ({ op: 'and', children: c })
  const builtin = (name, pawnField, type = 'number', dflt = 0) => ({ name, type, default: dflt, source: { kind: 'builtin', name: pawnField } })
  return {
    parameters: [builtin('Mode', 'navMode')],
    states: [
      { name: 'Hold', goal: 'idle', speedScale: 0, isEntry: true, x: 40, y: 60 },
      { name: 'Walk', goal: 'path', targetKey: 'point', speedScale: 1, x: 260, y: 20 },
      { name: 'Script', goal: 'script', speedScale: 1, x: 260, y: 140 },
    ],
    transitions: [
      { from: 'Hold', to: 'Walk', condition: all(leaf('Mode', 'gt', 0.5), leaf('Mode', 'lt', 1.5)) },
      { from: 'Hold', to: 'Script', condition: all(leaf('Mode', 'gt', 1.5)) },
      { from: 'Walk', to: 'Hold', condition: all(leaf('Mode', 'lt', 0.5)) },
      { from: 'Walk', to: 'Script', condition: all(leaf('Mode', 'gt', 1.5)) },
      { from: 'Script', to: 'Hold', condition: all(leaf('Mode', 'lt', 0.5)) },
      { from: 'Script', to: 'Walk', condition: all(leaf('Mode', 'gt', 0.5), leaf('Mode', 'lt', 1.5)) },
    ],
  }
}

const brainAsset = {
  id: stableId('brain:bot'), name: 'Fps Bot Brain', kind: 'behavior', machine: botBrainMachine(),
  graph: { goals: [], evaluators: [], arbitrationInterval: 0.5 },
  fuzzy: { variables: [], rules: [], defuzzification: 'maxav' },
}

/**
 * The weapon a bot carries: a static mesh of the weapon alone (the viewmodel's weapon parts at rest, in the
 * viewmodel's frame: barrel along +Z), posed in the right hand by `GRIP`. The grip numbers are by eye on
 * the Ranger: change them and every bot's weapon moves together, since the hand frames are shared.
 */
const GRIP = {
  ak47: { position: [0.02, 0.02, 0.04], rotation: [0, 90, 90], about: [0.1, -0.14, 0.2] },
  pistol: { position: [0.02, 0.02, 0.04], rotation: [0, 90, 90], about: [0.1, -0.14, 0.2] },
  shotgun: { position: [0.02, 0.02, 0.04], rotation: [0, 90, 90], about: [0.1, -0.14, 0.2] },
}

function botWeapon(key) {
  const vm = viewmodels[key]
  const spec = VIEWMODELS[key]
  const g = GRIP[key]
  // The weapon's mesh around the point of the viewmodel the right hand holds.
  const parts = vm.weaponParts
  const positions = [], normals = [], uvs = [], indices = [], submeshes = []
  for (const p of parts) {
    const base = positions.length / 3
    submeshes.push({ start: indices.length, count: p.indices.length })
    for (let i = 0; i < p.positions.length; i += 3) positions.push(p.positions[i] - g.about[0], p.positions[i + 1] - g.about[1], p.positions[i + 2] - g.about[2])
    normals.push(...p.normals); uvs.push(...p.uvs)
    for (const i of p.indices) indices.push(i + base)
  }
  const mats = parts.map(p => p.material)
  const mesh = node(spec.name, 'model', {
    id: stableId(`botweapon:${key}:mesh`), position: g.position, rotation: g.rotation,
    variables: vars({ __materialId: mats[0], __materialIds: JSON.stringify(mats) }),
    model: {
      geometry: { positions: positions.map(round3), normals: normals.map(round3), tangents: [], bitangents: [], texCoords: uvs.map(v => Math.round(v * 1e4) / 1e4), indices },
      material: matJson(mats[0]), materials: mats.map(matJson), submeshes,
    },
    children: [node('Muzzle', 'node', { id: stableId(`botweapon:${key}:muzzle`), position: vm.muzzle.map((v, i) => round3(v - g.about[i])) })],
  })
  const holder = group(`botweapon:${key}`, spec.name, [mesh], {
    variables: vars({ fpsWeapon: key }),
    socketAttachment: { target: 'parent', socket: 'RightHand' },
  })
  return holder
}

function botNode(botKey, { name, weapon = 'ak47' } = {}) {
  const bot = bots[botKey]
  const spec = bot.spec
  const rootId = stableId(`bot:${botKey}:root`)
  const model = bot.placement(`bot:${botKey}`)
  model.id = stableId(`bot:${botKey}:model`)
  const weapons = group(`bot:${botKey}:weapons`, 'Weapons', ['ak47', 'pistol', 'shotgun'].map(k => {
    const w = botWeapon(k)
    w.id = stableId(`bot:${botKey}:weapon:${k}`)
    return w
  }))
  const brain = node('Brain', 'controller', {
    id: stableId(`bot:${botKey}:brain`), possessedId: rootId, controlSource: 'ai', brain: 'machine',
    aimSource: 'world', driveAimTarget: false, autoAcquire: false, targetKey: 'target', goal: 'idle',
    perception: { fieldOfView: 140, range: 55, memorySpan: 8, reactionTime: 0.2 },
    eyeHeight: 1.6, steering: { maxSpeed: 5, arriveRadius: 0.8, slowRadius: 2.5, standoff: 1.5, avoidDistance: 1.6 },
    waypointRadius: 0.7, brainId: brainAsset.id, behavior: botBrainMachine(),
  })
  const children = [model, weapons, soundsGroup(`bot:${botKey}`, COMBAT_CUES, { spatial: true }), brain]
  return withScript(node(name ?? spec.name, 'character', {
    id: rootId, children,
    walkSpeed: 4.4, runSpeed: 6.9, turnSpeed: 540, turnThreshold: 170, acceleration: 16, facingMode: 'velocity', directionSmoothing: 0.12, jumpSpeed: 0,
    body: capsuleBody(0.3, 1.78, 75),
  }), 'FpsBot', { displayName: name ?? spec.name, respawnTemplate: 'FPS Bot', weapon })
}

// =====================================================================================================
// Templates
// =====================================================================================================

const markerNode = (kind) => withScript(node(kind === 'spawn' ? 'FPS Spawn Point' : 'FPS Cover Point', 'node', { id: stableId(`marker:${kind}`) }), 'FpsMarker', { kind })
const managerNode = () => withScript(node('FPS Game Manager', 'node', { id: stableId('manager') }), 'FpsGameManager', {})

const T = {}
function buildTemplates() {
  const list = []
  const add = (key, tree, textureIds = []) => { const t = asTemplate(key, tree, textureIds); T[key] = t; list.push(t); return t }
  add('manager', managerNode())
  add('player', playerNode(), [...new Set(['ak47', 'pistol', 'shotgun'].flatMap(k => viewmodels[k].textureIds))])
  add('spawn', markerNode('spawn'))
  add('cover', markerNode('cover'))
  add('flash', flashTemplate())
  add('impact', impactTemplate())
  add('blood', bloodTemplate())
  add('hole', holeTemplate(), [HOLE_TEX])
  add('tracer', tracerTemplate())
  // The bots: the Ranger is the base ("FPS Bot", what the manager respawns), the others are variants of it.
  const base = add('bot', botNode('ch05', { name: 'FPS Bot' }), [...bots.ch05.textureIds, ...['ak47', 'pistol', 'shotgun'].flatMap(k => viewmodels[k].textureIds)])
  const names = { ch05: 'Ranger', ch15: 'Vanguard', ch35: 'Raider', swat: 'Swat' }
  for (const key of ['ch15', 'ch35', 'swat']) {
    const v = variantTemplate(`bot:${key}`, base, botNode(key, { name: `FPS ${names[key]}` }), bots[key].textureIds)
    T[`bot:${key}`] = v
    list.push(v)
  }
  return list
}
const templates = buildTemplates()
// The base is "FPS Bot": it plays as the Ranger. Respawns re-instantiate it, and the manager copies the dead bot's team.
log('templates', templates.map(t => t.name).join(', '))

// =====================================================================================================
// Scenes
// =====================================================================================================

const navBaker = headlessNavBaker(ROOT)
const isMover = (n) => n.type === 'character'

/** Euler degrees toward a sun travelling along `dir` (a light shines down its node's forward). */
const eulerToward = (dir) => {
  const d = vec3.normalize(vec3.create(), dir)
  const q = quat.rotationTo(quat.create(), [0, 0, 1], d)
  return eulerFromQuat(q)
}

function environment({ rain = false } = {}) {
  const sun = sourceNode('light')
  sun.name = 'Sun'
  sun.id = stableId('sun')
  sun.rotation = eulerToward([-0.55, -0.42, -0.72])
  sun.light = { unit: 'photometric', color: PRESETS.sun.color, intensity: PRESETS.sun.intensity, angularRadius: PRESETS.sun.angularRadius * 2 }
  sun.castShadows = true

  const sky = sourceNode('sky atmosphere')
  sky.id = stableId('sky')
  sky.atmosphere = {
    ...sky.atmosphere, ...PRESETS.sky, physicalUnits: true, godRaysEnabled: true, godRayMaxDistance: 140, godRayDensity: 0.2,
    fogEnabled: true, fogDensity: 0.00035, fogStart: 60, fogMaxOpacity: 0.35,
  }
  const clouds = sourceNode('volumetric clouds')
  clouds.id = stableId('clouds')
  clouds.clouds = { ...clouds.clouds, ...PRESETS.clouds, useSceneWind: true }
  const wind = node('Wind', 'wind', { id: stableId('wind'), wind: { direction: [1, 0, 0.3], ...PRESETS.wind } })
  const skyLight = node('Sky Light', 'skyLight', { id: stableId('skylight'), skyLight: { cloudShadows: true, cloudResponse: 0.35, nightAmbient: 0.0001 } })
  const weather = node('Weather', 'weather', {
    id: stableId('weather'), position: [0, 12, 0],
    weather: { ...(rain ? PRESETS.weatherRain : PRESETS.weatherDry), size: [120, 30, 120], blendDistance: 8, priority: 0, enabled: true, shelter: true },
  })
  const fog = node('Ground Fog', 'volumetricFog', {
    id: stableId('fog'), position: [0, 3, 0],
    volumetricFog: { size: [110, 8, 110], blendDistance: 6, priority: 0, enabled: true, ...PRESETS.groundFog, density: 0.004 },
  })
  const dust = node('Dust', 'volumetricFog', {
    id: stableId('dust'), position: [0, 5, 0],
    volumetricFog: { size: [60, 10, 60], blendDistance: 8, priority: 1, enabled: true, ...PRESETS.dust, density: 0.002 },
  })
  const probe = sourceNode('light probe')
  probe.id = stableId('probe')
  probe.position = [0, 4, 0]
  probe.size = [110, 20, 110]
  probe.blendDistance = 30
  probe.mode = 'realtime'
  return [sun, sky, skyLight, clouds, wind, weather, fog, dust, probe]
}

function floodLights(points) {
  return group('floods', 'Flood Lights', points.map(([x, y, z], i) => node(`Flood ${i + 1}`, 'light', {
    id: stableId(`flood:${i}`), position: [x, y, z], rotation: [Math.atan2(Math.hypot(x, z), y) * 180 / Math.PI * 0 + 62, Math.round(Math.atan2(-x, -z) * 180 / Math.PI), 0],
    lightType: 'spotlight', castShadows: false,
    light: { unit: 'photometric', color: [1, 0.93, 0.8], intensity: 60000, range: 70, sourceRadius: 0.2, cutOff: 40, outerCutOff: 55, legacyFalloff: false },
  })))
}

/**
 * One scene. `bots` is [{ bot, name, skill, weapon, at: [x, z], yaw }]; the manager's `mode` decides who fights whom.
 */
function arenaScene({ key, name, mode, scoreLimit = 20, botList, minimal = false, rain = false, withPlayer = true }) {
  const { level, spawns, covers, lamps } = arenaLevel({ deck: !minimal, dressing: !minimal })
  const place = (n, x, z, yaw = 0, y = 0.05) => { n.position = [x, y, z]; n.rotation = [0, yaw, 0]; return n }

  const spawnNodes = spawns.map(([x, y, z, yaw], i) => {
    const n = withScript(node(`Spawn ${i + 1}`, 'node', { id: stableId(`${key}:spawn:${i}`) }), 'FpsMarker', { kind: 'spawn' })
    return linkInstance(T.spawn, place(n, x, z, yaw, 0.05))
  })
  const coverNodes = covers.map(([x, , z], i) => {
    const n = withScript(node(`Cover ${i + 1}`, 'node', { id: stableId(`${key}:cover:${i}`) }), 'FpsMarker', { kind: 'cover' })
    n.name = 'FPS Cover Point'
    return linkInstance(T.cover, place(n, x, z, 0, 0.05))
  })

  const manager = linkInstance(T.manager, withScript(managerNode(), 'FpsGameManager', { mode, scoreLimit }))
  const player = withPlayer ? linkInstance(T.player, place(playerNode(), spawns[0][0], spawns[0][2], spawns[0][3])) : null
  const botNodes = botList.map((b, i) => {
    const tmpl = T[b.bot === 'ch05' ? 'bot' : `bot:${b.bot}`]
    const n = botNode(b.bot, { name: tmpl.name, weapon: b.weapon ?? 'ak47' })
    withScript(n, 'FpsBot', { displayName: b.name, respawnTemplate: 'FPS Bot', weapon: b.weapon ?? 'ak47', skill: b.skill ?? 0.55 })
    n.id = stableId(`${key}:bot:${i}`)
    // The brain possesses its own character, by id.
    n.children.find(c => c.type === 'controller').possessedId = n.id
    return linkInstance(tmpl, place(n, b.at[0], b.at[1], b.yaw ?? 0))
  })

  const navMesh = node('Nav Mesh', 'navMesh', { id: stableId(`${key}:navmesh`), position: [0, 12, 0], bake: {}, agentRadius: 0.45, size: [110, 40, 110] })

  const root = node('root', 'node', {
    id: stableId(`${key}:root`),
    children: [
      manager,
      ...(player ? [player] : []),
      ...environment({ rain }),
      group('level', 'Level', level),
      floodLights(lamps),
      group('spawns', 'Spawn Points', spawnNodes),
      group('cover', 'Cover Points', coverNodes),
      group('fighters', 'Bots', botNodes),
      navMesh,
    ],
    ambientLight: [700, 750, 900],
  })
  const { surface, obstacles } = navBaker.gather(root, { skip: isMover })
  const baked = navBaker.bakeInto(navMesh, { surface, obstacles })
  log(`navmesh ${key}`, `${baked.regions} regions, ${baked.triangles} triangles, ${baked.obstacles} obstacles, ${baked.ms} ms`)

  const config = clone(seedScene.config)
  Object.assign(config.render, {
    quality: 'high', motionBlurEnabled: true, motionBlurIntensity: 0.6,
    ...PRESETS.exposure, exposureCompensation: 0.65, ...PRESETS.look, ...PRESETS.dof, dofEnabled: false,
    toneMapper: 'agxPunchy', shadowMapResolution: 4096, shadowCascades: 4, shadowDistance: 120,
    clearColor: [0.5, 0.6, 0.72, 1],
  })
  config.graphics.clearColor = [0.5, 0.6, 0.72, 1]
  return { scene: root, textures: [], ui: { version: 1, elements: [] }, config, assetHashes: {}, assetHashVersion: ASSET_HASH_VERSION, savedAt: CREATED_AT }
}

const BOT_POSITIONS = [[-30, 30, 150], [30, 30, -150], [-30, -30, 30], [30, -30, -30]]
const BOT_SET = [
  { bot: 'ch05', name: 'Ranger', skill: 0.6 }, { bot: 'ch15', name: 'Vanguard', skill: 0.5 },
  { bot: 'ch35', name: 'Raider', skill: 0.55 }, { bot: 'swat', name: 'Swat', skill: 0.65 },
]
const withAt = (list) => list.map((b, i) => ({ ...b, at: [BOT_POSITIONS[i][0], BOT_POSITIONS[i][1]], yaw: BOT_POSITIONS[i][2] }))

const SCENES = [
  { key: 'main', name: `${PROJECT_NAME} - 1v3`, mode: 'oneVsThree', botList: withAt(BOT_SET.slice(0, 3)), scoreLimit: 15 },
  { key: 'twovtwo', name: `${PROJECT_NAME} - 2v2`, mode: 'team2v2', botList: withAt(BOT_SET.slice(0, 3)), scoreLimit: 20 },
  { key: 'ffa', name: `${PROJECT_NAME} - FFA`, mode: 'ffa', botList: withAt(BOT_SET.slice(0, 3)), scoreLimit: 15, rain: true },
  {
    key: 'minimal', name: 'Minimal', mode: 'ffa', minimal: true, scoreLimit: 10,
    botList: [{ bot: 'swat', name: 'Swat', skill: 0.6, at: [12, 12], yaw: -135 }, { bot: 'ch15', name: 'Vanguard', skill: 0.5, at: [-12, 12], yaw: 135 }],
  },
]

// =====================================================================================================
// Write
// =====================================================================================================

function sceneRefs(refs) {
  return {
    version: SCENE_REFS_VERSION,
    materialIds: [], modelIds: [], templateIds: [], terrainMaterialIds: [], tilesetIds: [],
    aiBrainIds: [], textureIds: [], scriptIds: [], animationFieldIds: [], foliageModelIds: [],
    soundSampleIds: [], audioSourceIds: [], animationIds: [], particleSystemIds: [],
    ...refs,
  }
}

const FOLDERS = {
  scene: { }, // filled below
  script: Object.fromEntries(scripts.assets.map(s => [s.name, '/FPS/Scripts'])),
  template: {
    'FPS Game Manager': '/FPS/Match', 'FPS Spawn Point': '/FPS/Match', 'FPS Cover Point': '/FPS/Match',
    'FPS Player': '/FPS/Player',
    'FPS Bot': '/FPS/Bots', 'FPS Vanguard': '/FPS/Bots', 'FPS Raider': '/FPS/Bots', 'FPS Swat': '/FPS/Bots',
    'FPS Muzzle Flash': '/FPS/Effects', 'FPS Impact': '/FPS/Effects', 'FPS Blood Hit': '/FPS/Effects',
    'FPS Bullet Hole': '/FPS/Effects', 'FPS Tracer': '/FPS/Effects',
  },
  rig: { 'Mixamo Rifle Pack': '/FPS/Bots/Rigs', Ranger: '/FPS/Bots/Rigs', Vanguard: '/FPS/Bots/Rigs', Raider: '/FPS/Bots/Rigs', Swat: '/FPS/Bots/Rigs' },
  model: {
    Ranger: '/FPS/Bots/Models', Vanguard: '/FPS/Bots/Models', Raider: '/FPS/Bots/Models', Swat: '/FPS/Bots/Models',
    'AK-47 Viewmodel': '/FPS/Weapons/Models', 'Pistol Viewmodel': '/FPS/Weapons/Models', 'SAPS-12 Viewmodel': '/FPS/Weapons/Models',
  },
  animationField: { 'Fps Locomotion': '/FPS/Bots/Animations', 'Fps Crouch Locomotion': '/FPS/Bots/Animations' },
  animController: { 'Fps Bot': '/FPS/Bots/Animations' },
  aiBrain: { 'Fps Bot Brain': '/FPS/Bots/AI' },
  particleSystem: { 'Muzzle Flash': '/FPS/Effects/Particles', 'Bullet Impact': '/FPS/Effects/Particles', 'Blood Hit': '/FPS/Effects/Particles' },
}

function materialFolder(m) {
  if (/^(Ranger|Vanguard|Raider|Swat) /.test(m.name)) return `/FPS/Bots/Materials`
  if (/Viewmodel|AK-47|Pistol|SAPS|Case|Weapon|HIpistol|Material\./.test(m.name)) return '/FPS/Weapons/Materials'
  if (/Bullet Hole|Tracer/.test(m.name)) return '/FPS/Effects/Materials'
  return '/FPS/Level/Materials'
}

function vfs(libraries, textureIds, scenes) {
  const entries = []
  const add = (kind, items, folderOf) => {
    const ext = KIND_EXT[kind]
    if (!ext) throw new Error(`no virtual extension for kind "${kind}"`)
    for (const item of items) {
      const folder = folderOf(item)
      if (!folder) throw new Error(`no Assets folder for ${kind} "${item.name}" - add it to FOLDERS in tools/fps/build.mjs`)
      entries.push({ path: `${folder}/${item.name}${ext}`, kind, assetId: item.id, created: CREATED_AT })
    }
  }
  add('scene', scenes, () => '/Scenes')
  add('script', libraries.scripts, i => FOLDERS.script[i.name])
  add('template', libraries.templates, i => FOLDERS.template[i.name])
  add('model', libraries.models, i => FOLDERS.model[i.name])
  add('material', libraries.materials, materialFolder)
  add('rig', libraries.rigs, i => FOLDERS.rig[i.name])
  add('animationField', libraries.animationFields, i => FOLDERS.animationField[i.name])
  add('animController', libraries.animControllers, i => FOLDERS.animController[i.name])
  add('animation', libraries.animations, () => '/FPS/Bots/Animations/Clips')
  add('particleSystem', libraries.particleSystems, i => FOLDERS.particleSystem[i.name])
  add('aiBrain', libraries.aiBrains, i => FOLDERS.aiBrain[i.name])
  // A texture's record and its source image share the texture's id; the editor re-derives both on import.
  const named = new Map()
  for (const m of libraries.materials) for (const [slot, id] of Object.entries(m.material.textures ?? {})) {
    if (!id || named.has(id)) continue
    const slotName = { baseColorTexture: 'Base Color', metallicRoughnessTexture: 'ARM', normalMap: 'Normal' }[slot] ?? slot
    named.set(id, { folder: `${materialFolder(m).replace(/Materials$/, '')}Textures`, name: `${m.name} ${slotName}`, mime: textures._entries.get(id)?.mime })
  }
  for (const [id, t] of named) {
    entries.push({ path: `${t.folder}/${t.name}${KIND_EXT.texture}`, kind: 'texture', assetId: id, created: CREATED_AT })
    entries.push({ path: `${t.folder}/Source/${t.name}.${t.mime === 'image/jpeg' ? 'jpg' : 'png'}`, kind: 'image', assetId: id, created: CREATED_AT })
  }
  const unlisted = textureIds.filter(id => !named.has(id))
  if (unlisted.length) throw new Error(`no Assets folder for texture(s) ${unlisted.join(', ')}`)
  const paths = entries.map(e => e.path)
  const clash = paths.find((p, i) => paths.indexOf(p) !== i)
  if (clash) throw new Error(`two assets both want the vfs path "${clash}"`)
  const dirs = [...new Set(entries.map(e => e.path.slice(0, e.path.lastIndexOf('/'))).filter(Boolean))]
  const withParents = new Set()
  for (const f of dirs) { const parts = f.split('/').filter(Boolean); for (let i = 1; i <= parts.length; i++) withParents.add('/' + parts.slice(0, i).join('/')) }
  return { version: 1, folders: [...withParents].sort(), entries }
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  fs.mkdirSync(path.join(OUT, 'libraries'), { recursive: true })
  fs.mkdirSync(path.join(OUT, 'scenes'), { recursive: true })

  const built = SCENES.map(s => ({ ...s, id: stableId(`scene:${s.key}`), json: arenaScene(s) }))

  // Models: the four bots and the three viewmodels, as library assets.
  const models = [...BOT_KEYS.map(k => bots[k].model), ...['ak47', 'pistol', 'shotgun'].map(k => viewmodels[k].model)]
  const rigs = [clipRig, ...BOT_KEYS.map(k => bots[k].rig)]
  const libraries = {
    models, materials, terrainMaterials: [], animationFields: fields, animControllers: [botController], boneMasks: [],
    animations, rigs, tilesets: [], scripts: scripts.assets, templates, particleSystems, aiBrains: [brainAsset],
  }
  // Model assets carry no embedded clips (the viewmodels' are their own: they play by name).
  for (const [name, value] of Object.entries(libraries)) writeJson(path.join(OUT, 'libraries', `${name}.json`), value)
  writeJson(path.join(OUT, 'libraries', 'inputMap.json'), FPS_INPUT_MAP)

  const written = (name) => readJson(path.join(OUT, 'libraries', `${name}.json`))
  const hashes = {}
  for (const [kind, lib] of [['template', 'templates'], ['material', 'materials'], ['model', 'models'], ['script', 'scripts'], ['aiBrain', 'aiBrains']])
    for (const asset of written(lib)) hashes[assetHashKey(kind, asset.id)] = hashAsset(asset)
  for (const s of built) {
    s.json.assetHashes = { ...hashes }
    writeJson(path.join(OUT, 'scenes', `${s.id}.json`), s.json)
  }
  const textureCount = textures.write(OUT)

  const refs = () => sceneRefs({
    materialIds: materials.map(m => m.id), modelIds: models.map(m => m.id), templateIds: templates.map(t => t.id),
    textureIds: textures.included, scriptIds: scripts.assets.map(s => s.id), animationFieldIds: fields.map(f => f.id),
    animationIds: animations.map(a => a.id), particleSystemIds: particleSystems.map(p => p.id), aiBrainIds: [brainAsset.id],
  })
  writeJson(path.join(OUT, 'manifest.json'), {
    formatVersion: 1, kind: 'project', createdAt: CREATED_AT, projectName: PROJECT_NAME,
    mainSceneId: built[0].id, openSceneId: built[0].id,
    sceneMetas: built.map(s => ({ id: s.id, name: s.name, updatedAt: CREATED_AT, dimension: '3D', refs: refs() })),
  })
  writeJson(path.join(OUT, 'vfs.json'), vfs(libraries, textures.included, built.map(s => ({ id: s.id, name: s.name }))))
  writeJson(path.join(OUT, 'example.json'), {
    name: PROJECT_NAME,
    description: 'A first-person shooter: walk, sprint, crouch, aim down sights, hip and aimed fire, reloads and three weapons against bots that search, take cover, retreat when hurt and call for reinforcements. Free for all, 2v2 or one against three, all from the templates: put a Game Manager and some fighters in any scene and it plays.',
    order: 1,
  })
  return { total: walkSize(OUT), textureCount, templates: templates.length, materials: materials.length }
}

const result = main()
// Format 1 is what this writes; format 2 is what can be checked in: the clips and the models' geometry are
// stored once as binary, in split parts under GitHub's 100 MB file limit (exampleKit/packFormat2.mjs).
const largest = await packFormat2(OUT, { giBakes: [] })
console.log(`${PROJECT_NAME} written to ${path.relative(ROOT, OUT)}/`)
console.log(`  scripts ${scripts.assets.length} - templates ${result.templates} - materials ${result.materials} - clips ${animations.length} - effects ${particleSystems.length} - textures ${result.textureCount} - ${mb(result.total)} unpacked - largest file ${mb(largest)}`)
console.log('Next:  npm --prefix editor run examples:list')
