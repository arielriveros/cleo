#!/usr/bin/env node
// Authors the "Night Shift" example project into editor/public/examples/night-shift/.
//
//     node tools/nightShift/build.mjs
//     npm --prefix editor run examples:list      # regenerates the gallery index
//
// ## Why this is a generator and not a checked-in folder
//
// The output is ~160 MB, nearly all of it texture and geometry payloads that already exist in the
// 3d-example project. Re-packaging them here means the interesting part — the scene, the behaviour
// machine, the UI, the script wiring — stays reviewable as ~700 lines of code instead of arriving as an
// unreadable 20 MB JSON diff. Every id is derived deterministically, so a re-run is byte-identical and
// only real changes show up.
//
// ## What it does NOT do
//
// It imports nothing. The deleted `tools/harness` existed to pull models through a real GPU process;
// none of that is needed, because every mesh, skeleton and texture here is copied from a project that
// already imported them. The only new art is three tiny sprite atlases, packed offline by
// `packSprites.py` and committed under `sprites/`.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { TextureSet, loadScriptReflector, mb, node, readJson, stableId, uiNode, vars, writeJson }
  from './bundle.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'editor', 'public', 'examples', '3d-example')
const OUT = path.join(ROOT, 'editor', 'public', 'examples', 'night-shift')
const SCRIPTS = path.join(ROOT, 'examples', 'scripts')

// Fixed, so `createdAt` does not churn the manifest on every run.
const CREATED_AT = 1788000000000

const NIGHT_SCENE = stableId('scene:night')
const MENU_SCENE = stableId('scene:menu')
const MANNEQUIN_MODEL = '93cbfa0b91ad0e985b9993b34e60ad7a'
const LOCOMOTION_FIELD = 'b7a7c98632e7754373bb3b23941a15bf'

// The zombie's own model and clips, converted offline from `build/zombie/*.fbx` by
// `importZombie.mjs` and committed. `build/` is gitignored, so the .fbx files cannot be a build input:
// the example has to regenerate byte-identically on a clean checkout.
const ZOMBIE_MODEL = path.join(HERE, 'zombieModel.json')
const ZOMBIE_CLIPS = path.join(HERE, 'zombieClips.json')
const ZOMBIE_TEXTURES = path.join(HERE, 'zombie')

/** Texture id -> the committed file and how it is encoded. Diffuse is JPEG, normals stay PNG. */
const ZOMBIE_MAPS = [
  ['zombie-1001-diffuse', 'Ch10_1001_Diffuse.jpg', 'image/jpeg'],
  ['zombie-1001-normal', 'Ch10_1001_Normal.png', 'image/png'],
  ['zombie-1002-diffuse', 'Ch10_1002_Diffuse.jpg', 'image/jpeg'],
  ['zombie-1002-normal', 'Ch10_1002_Normal.png', 'image/png'],
]

const reflect = loadScriptReflector(ROOT)

// ---------------------------------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------------------------------

/**
 * The script library.
 *
 * `variables` is a derived cache the editor's inspector is built from, so it is reflected out of the
 * source with the editor's own parser rather than hand-written.
 */
const SCRIPT_FILES = [
  ['Level Director', 'NightShiftDirector', 'node'],
  ['Player', 'NightShiftPlayer', 'character'],
  ['Zombie', 'NightShiftZombie', 'character'],
  ['Zombie Brain', 'NightShiftZombieBrain', 'controller'],
  ['Zombie Spawner', 'NightShiftSpawner', 'node'],
  ['Pickup Spawner', 'NightShiftPickupSpawner', 'node'],
  ['Pickup', 'NightShiftPickup', 'node'],
  ['Powerup', 'NightShiftPowerup', 'node'],
  ['HUD', 'NightShiftHud', 'uiRoot'],
  ['End Screen', 'NightShiftEndScreen', 'uiRoot'],
  ['Camera Pivot', 'ThirdPersonCameraPivot', 'cameraRig'],
]

function buildScripts() {
  const assets = []
  const byFile = new Map()
  for (const [name, file, baseType] of SCRIPT_FILES) {
    const source = fs.readFileSync(path.join(SCRIPTS, `${file}.ts`), 'utf8')
    const asset = { id: stableId(`script:${file}`), name, baseType, source, variables: reflect(source) }
    assets.push(asset)
    byFile.set(file, asset)
  }
  return { assets, byFile }
}

const scripts = buildScripts()

/** Attach a script to a node: the library link AND the inline source, exactly as the editor writes it. */
function withScript(target, file, scriptVars = {}) {
  const asset = scripts.byFile.get(file)
  if (!asset) throw new Error(`no script asset for ${file}`)
  target.variables = { ...(target.variables ?? {}), ...vars({ __scriptId: asset.id }) }
  target.script = asset.source
  target.scriptVars = scriptVars
  return target
}

// ---------------------------------------------------------------------------------------------------
// Source project
// ---------------------------------------------------------------------------------------------------

const sourceScene = readJson(path.join(SRC, 'scenes', 'afe4727c54de62f1bafbf6ac25c32b74.json'))
const sourceModels = readJson(path.join(SRC, 'libraries', 'models.json'))
const sourceMaterials = readJson(path.join(SRC, 'libraries', 'materials.json'))
const sourceTerrainMats = readJson(path.join(SRC, 'libraries', 'terrainMaterials.json'))
const sourceFields = readJson(path.join(SRC, 'libraries', 'animationFields.json'))
const sourceTemplates = readJson(path.join(SRC, 'libraries', 'templates.json'))

const textures = new TextureSet(SRC)

function sourceNode(name) {
  const walk = (n) => n.name === name ? n : (n.children ?? []).reduce((a, c) => a ?? walk(c), null)
  const found = walk(sourceScene.scene)
  if (!found) throw new Error(`the 3d-example scene has no node named "${name}"`)
  return JSON.parse(JSON.stringify(found))
}

// ---------------------------------------------------------------------------------------------------
// Tilesets — the sprite pickups
// ---------------------------------------------------------------------------------------------------

const SPRITES = [
  ['pickup-score', 'Score Diamond', 5],
  ['pickup-speed', 'Speed Glow', 4],
  ['pickup-powerup', 'Powerup Flame', 4],
]

function buildTilesets() {
  return SPRITES.map(([file, name, frames]) => {
    const png = path.join(HERE, 'sprites', `${file}.png`)
    if (!fs.existsSync(png)) {
      throw new Error(`missing ${png} — run: python tools/nightShift/packSprites.py`)
    }
    const { width, height } = pngSize(png)
    const textureId = textures.add(file, png, { mipMap: false, wrapping: 'clamp' })
    return {
      id: stableId(`tileset:${file}`),
      name,
      textureId,
      imageWidth: width,
      imageHeight: height,
      tileWidth: Math.floor(width / frames),
      tileHeight: height,
      margin: 0,
      spacing: 0,
      columns: frames,
      rows: 1,
      tiles: {},
      terrains: [],
      variantSets: [],
      textureIds: [textureId],
    }
  })
}

/** PNG dimensions straight out of the IHDR, so the generator needs no image library. */
function pngSize(file) {
  const head = Buffer.alloc(24)
  const fd = fs.openSync(file, 'r')
  fs.readSync(fd, head, 0, 24, 0)
  fs.closeSync(fd)
  if (head.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`)
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

/**
 * The flame. `fire.png` is already in the source project as an 8x4 sheet; it just never had a tileset,
 * because the Torch that uses it predates the tileset system and still carries the legacy payload.
 */
function fireTileset() {
  const entry = readJson(path.join(SRC, 'textures', 'index.json')).find(t => t.id === 'fire.png')
  const { width, height } = pngSize(path.join(SRC, entry.file))
  textures.copy('fire.png')
  return {
    id: stableId('tileset:fire'), name: 'Flame', textureId: 'fire.png',
    imageWidth: width, imageHeight: height,
    tileWidth: Math.floor(width / 8), tileHeight: Math.floor(height / 4),
    margin: 0, spacing: 0, columns: 8, rows: 4,
    tiles: {}, terrains: [], variantSets: [], textureIds: ['fire.png'],
  }
}

const tilesets = [...buildTilesets(), fireTileset()]
const tilesetNamed = (textureId) => {
  const found = tilesets.find(t => t.textureId === textureId)
  if (!found) throw new Error(`no tileset for texture "${textureId}"`)
  return found
}

/**
 * A sprite's payload, with its tileset EMBEDDED.
 *
 * `Sprite.serialize` writes the whole tileset alongside its id, not just the reference — the published
 * player parses a scene with no library to resolve against. Writing only `tilesetId` produces a sprite
 * that renders as nothing, with no error.
 */
function spritePayload(textureId, constraints, tint) {
  const asset = tilesetNamed(textureId)
  const { id, name, thumbnail, textureIds, ...runtime } = asset
  return {
    sprite: {
      constraints,
      tilesetId: id,
      tileset: { id, ...runtime },
      tileIndex: 0,
      tint,
      opacity: 1,
      transparent: true,
      side: 'front',
      wireframe: false,
    },
    animation: {
      frames: Array.from({ length: asset.columns * asset.rows }, (_, i) => i),
      frameSource: 'node',
      fps: 10,
      loop: true,
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------------

const playableTemplate = JSON.parse(JSON.stringify(
  sourceTemplates.find(t => t.name === 'Playable')))

/**
 * The player's driver, as a CHILD of the character it possesses — the same shape the Zombie's `Brain`
 * has, and for the same reason.
 *
 * A placed template instance is rebuilt with fresh ids whenever the template changes underneath it
 * (`syncTemplateInstances`, `sceneResync.reinstantiate`). A controller sitting outside the instance keeps
 * pointing at the id the character USED to have, and the player silently stops moving with nothing but a
 * per-frame warning to say why. Inside, it is remapped by the same pass that renumbers everything else —
 * `possessedId` is in `NODE_REF_KEYS`, and `regenerateNodeIds` remaps in a second pass once the whole
 * subtree's ids are known.
 *
 * ## It has to be the LAST child
 *
 * `ControllerNode._findRig` walks the pawn's children depth-first and takes the first `CameraRigNode` it
 * meets. With `aimSource: 'possessed'` — which is what makes the character move relative to the camera —
 * that walk now includes the controller itself. Keeping the camera rig ahead of it means the rig is found
 * at index 0 and the controller is never even visited. The Zombie orders its `Brain` last for symmetry,
 * though it never exercises this: it aims in world space.
 */
function playerController(pawnId, id) {
  return node('Player Controller', 'controller', {
    id,
    possessedId: pawnId,
    aimSourceId: null,
    controlSource: 'player',
    // ACTION names, not keys, so the whole scheme is rebindable in the Input panel without touching this.
    moveAction: 'Move',
    lookAction: 'Look',
    jumpAction: 'Jump',
    sprintAction: 'Sprint',
    crouchAction: '',
    aimSource: 'possessed',
    driveAimTarget: true,
  })
}

// The player is one self-contained thing, exactly as the zombie is.
playableTemplate.nodeJson.children.push(
  playerController(playableTemplate.nodeJson.id, stableId('template:player:controller')))

/**
 * The zombie: its own Mixamo character, driven by a brain instead of a player.
 *
 * The Character and its Controller go in ONE template so the controller's `possessedId` — a registered
 * node reference — is remapped per instance. Split across two, every spawned brain would drive the
 * template's original character and the whole horde would move as one body.
 *
 * The model used to be a copy of the player's mannequin with its clip list trimmed, which is why the
 * enemies were grey debug people walking normally. It is now the real thing: a 49,593-triangle
 * character in two material tiles, with Idle, Walk and Dying authored for it. The mannequin stays
 * where it belongs, on the player.
 */
function zombieTemplate() {
  for (const file of [ZOMBIE_MODEL, ZOMBIE_CLIPS]) {
    if (!fs.existsSync(file)) {
      throw new Error(`missing ${path.relative(ROOT, file)} — run: `
        + 'node --max-old-space-size=8192 tools/nightShift/importZombie.mjs')
    }
  }

  const payload = readJson(ZOMBIE_MODEL)
  payload.animations = readJson(ZOMBIE_CLIPS)

  for (const [id, file, mime] of ZOMBIE_MAPS) {
    const full = path.join(ZOMBIE_TEXTURES, file)
    if (!fs.existsSync(full)) {
      throw new Error(`missing ${path.relative(ROOT, full)} — run: `
        + 'python tools/nightShift/packZombieTextures.py')
    }
    // `usage: 'color'` for the diffuse and 'data' for the normals: a normal map read through sRGB is
    // the classic washed-out-lighting bug, and the mannequin's own normal map is declared the same way.
    textures.add(id, full, {
      wrapping: 'repeat', mipMap: true, usage: id.endsWith('normal') ? 'data' : 'color',
    }, mime)
  }

  const model = node('Ch10', 'model', {
    id: stableId('zombie:model'),
    model: payload,
    stateMachine: zombieStateMachine(),
    // The ragdoll block is pure scalar tuning — joint limits, masses, radii — with no per-bone list,
    // so the player's settings transfer to this skeleton unchanged.
    ragdoll: JSON.parse(JSON.stringify(
      playableTemplate.nodeJson.children.find(c => c.name === 'Ch36').ragdoll ?? null)),
  })

  const characterId = stableId('zombie:root')
  const brain = withScript(node('Brain', 'controller', {
    id: stableId('zombie:brain'),
    possessedId: characterId,
    controlSource: 'ai',
    brain: 'machine',
    aimSource: 'world',
    driveAimTarget: false,
    // Ours runs instead — see NightShiftZombieBrain for why this must be off.
    autoAcquire: false,
    targetKey: 'target',
    goal: 'idle',
    perception: { fieldOfView: 120, range: 18, memorySpan: 6, reactionTime: 0.4 },
    eyeHeight: 1.6,
    // A wide, lazy wander circle. `wander` aims at a point offset from the agent's own forward, so a
    // small circle far ahead keeps the offset angle — and therefore the turning it provokes — small.
    steering: {
      maxSpeed: 2.2, arriveRadius: 1.2, slowRadius: 3, standoff: 1.4, avoidDistance: 0,
      wanderDistance: 4, wanderRadius: 1, wanderJitter: 200,
    },
    waypointRadius: 0.6,
    behavior: zombieBehaviour(),
  }), 'NightShiftZombieBrain')

  const flameSprite = spritePayload('fire.png', 'cylindrical', [1, 0.72, 0.3])
  flameSprite.animation.fps = 30
  const flame = node('Flame', 'animatedSprite', {
    id: stableId('zombie:flame'),
    position: [0, 1.1, 0],
    scale: [1.6, 1.9, 1.6],
    visible: false,
    ...flameSprite,
  })

  const fireLight = node('Fire Light', 'light', {
    id: stableId('zombie:fire-light'),
    position: [0, 1, 0],
    visible: false,
    lightType: 'point',
    // `unit: 'photometric'` is what stops the constructors treating this as a pre-photometric payload
    // and re-converting it. Intensity is lumens.
    light: {
      unit: 'photometric', color: [1, 0.55, 0.16],
      intensity: 0, range: 9, sourceRadius: 0.1, legacyFalloff: false,
    },
    // Six depth rasterisations per light is not what a burning crowd should cost.
    castShadows: false,
  })

  const root = withScript(node('Zombie', 'character', {
    id: characterId,
    walkSpeed: 1.1,
    runSpeed: 2.4,
    // The WANDER rate, which is the entry state. NightShiftZombie raises it the moment the brain starts
    // hunting — a shambler that turned this slowly in a chase would be trivially circle-strafed.
    turnSpeed: 30,
    acceleration: 6,
    facingMode: 'velocity',
    directionSmoothing: 0.2,
    children: [model, flame, fireLight, brain],
  }), 'NightShiftZombie')

  return {
    template: {
      id: stableId('template:zombie'),
      name: 'Zombie',
      nodeJson: root,
      // Its own maps plus the flame sprite. The mannequin's three are NOT listed: the zombie no
      // longer borrows its mesh, so referencing them would ship the player's textures twice.
      textureIds: [...ZOMBIE_MAPS.map(([id]) => id), 'fire.png'],
      scripts: {},
      bodies: { [characterId]: zombieBody() },
      triggers: {},
    },
  }
}

/** The same capsule the player uses, at the same friction: a character owns its own speed. */
function zombieBody() {
  const source = playableTemplate.bodies[Object.keys(playableTemplate.bodies)[0]]
  return JSON.parse(JSON.stringify(source))
}

/** Idle when it has lost you, walk when it has not, stop to swing, and burn over everything. */
function zombieBehaviour() {
  const and = (...children) => ({ op: 'and', children })
  return {
    parameters: [
      { name: 'Sight', type: 'boolean', default: false, source: { kind: 'sense', name: 'targetInSight' } },
      { name: 'Dist', type: 'number', default: 999, source: { kind: 'sense', name: 'distanceToTarget' } },
      { name: 'Seen', type: 'number', default: 999, source: { kind: 'sense', name: 'timeSinceSeen' } },
      { name: 'Burning', type: 'boolean', default: false, source: { kind: 'builtin', name: 'burning' } },
    ],
    states: [
      { name: 'Idle', goal: 'wander', speedScale: 0.3, isEntry: true, x: 40, y: 40 },
      { name: 'Chase', goal: 'path', speedScale: 1, x: 260, y: 40 },
      { name: 'Attack', goal: 'idle', speedScale: 0, x: 470, y: 40 },
      { name: 'Investigate', goal: 'investigate', speedScale: 0.6, x: 260, y: 180 },
      { name: 'Burn', goal: 'idle', speedScale: 0, x: 470, y: 180 },
    ],
    transitions: [
      // Burn first: it is the only transition that may fire from anywhere, and it must win.
      { from: '*', to: 'Burn', condition: and({ param: 'Burning', op: 'true' }) },
      { from: 'Idle', to: 'Chase', condition: and({ param: 'Sight', op: 'true' }) },
      // The band is not optional. `Dist` is measured and never still, so a bare pair flips the machine
      // every frame at the boundary and the zombie lunges and retreats on the spot.
      { from: 'Chase', to: 'Attack', condition: and({ param: 'Dist', op: 'lt', value: 1.8, hysteresis: 0.4 }) },
      { from: 'Attack', to: 'Chase', condition: and({ param: 'Dist', op: 'gt', value: 1.8, hysteresis: 0.4 }) },
      {
        from: 'Chase', to: 'Investigate', minDwell: 0.4,
        condition: and({ param: 'Sight', op: 'false' }, { param: 'Seen', op: 'gt', value: 1.5 }),
      },
      { from: 'Investigate', to: 'Chase', condition: and({ param: 'Sight', op: 'true' }) },
      { from: 'Investigate', to: 'Idle', minDwell: 1, condition: and({ param: 'Seen', op: 'gt', value: 6 }) },
      { from: 'Attack', to: 'Investigate', condition: and({ param: 'Sight', op: 'false' }, { param: 'Seen', op: 'gt', value: 2 }) },
    ],
  }
}

/** Two states on measured speed. A zombie has one gait, so it needs no blend space. */
function zombieStateMachine() {
  return {
    parameters: [
      {
        name: 'Speed', type: 'variable', default: 0,
        variable: { nodeRef: 'parent', varName: 'planarSpeed', varType: 'number', source: 'builtin' },
      },
      // Fired once by NightShiftZombie._die(). A trigger rather than a variable because death is an
      // EVENT: a bool would have to be cleared by whatever set it, and there is nothing left alive to
      // clear it.
      { name: 'Died', type: 'trigger', default: false },
    ],
    states: [
      { name: 'Idle', clipName: 'Idle', loop: true, speed: 1, isEntry: true, x: 40, y: 40 },
      { name: 'Walk', clipName: 'Walk', loop: true, speed: 1, isEntry: false, x: 260, y: 40 },
      // No loop and no way out: the collapse plays once and the pose holds until the ragdoll takes the
      // skeleton over. `minDwell: 0` on the way in, because a zombie that finished burning should not
      // keep shambling for another sixth of a second.
      { name: 'Dying', clipName: 'Dying', loop: false, speed: 1, isEntry: false, x: 150, y: 200 },
    ],
    transitions: [
      {
        from: 'Idle', to: 'Walk', conditions: [], minDwell: 0.15, hasExitTime: false, exitTime: 1,
        condition: { op: 'and', children: [{ param: 'Speed', op: 'gt', value: 0.35, hysteresis: 0.2 }] },
      },
      {
        from: 'Walk', to: 'Idle', conditions: [], minDwell: 0.15, hasExitTime: false, exitTime: 1,
        condition: { op: 'and', children: [{ param: 'Speed', op: 'lt', value: 0.35, hysteresis: 0.2 }] },
      },
      // Written out per source state rather than as one `from: '*'`: the funnel is only two states
      // wide, and a wildcard would also fire Dying -> Dying on a machine that has no way back.
      {
        from: 'Idle', to: 'Dying', conditions: [], minDwell: 0, hasExitTime: false, exitTime: 1,
        condition: { op: 'and', children: [{ param: 'Died', op: 'trigger' }] },
      },
      {
        from: 'Walk', to: 'Dying', conditions: [], minDwell: 0, hasExitTime: false, exitTime: 1,
        condition: { op: 'and', children: [{ param: 'Died', op: 'trigger' }] },
      },
    ],
    events: [],
  }
}

// ---------------------------------------------------------------------------------------------------
// Pickups
// ---------------------------------------------------------------------------------------------------

/**
 * The four pickup templates.
 *
 * Authored as TEMPLATES rather than placed in the scene, because a level that puts the same twelve items
 * in the same twelve places every night is not much of a scavenge — and because every one of them had to
 * be floated above the terrain by hand. `NightShiftPickupSpawner` scatters them onto walkable ground at
 * runtime instead.
 */
function pickupTemplates() {
  const kinds = [
    ['Score Pickup', 'pickup-score', 'NightShiftPickup', { points: 100 }, [1, 0.85, 0.25], 1.2],
    ['Speed Powerup', 'pickup-speed', 'NightShiftPowerup', { kind: 'speed', radius: 16 }, [0.35, 0.9, 1], 1.4],
    ['Invincibility Powerup', 'pickup-speed', 'NightShiftPowerup', { kind: 'invincible', radius: 16 }, [1, 1, 1], 1.4],
    ['Fire Powerup', 'pickup-powerup', 'NightShiftPowerup', { kind: 'aoe', radius: 16 }, [1, 0.4, 0.15], 1.4],
  ]

  return kinds.map(([name, sprite, script, scriptVars, tint, scale]) => {
    const root = pickup(name, sprite, { scale: [scale, scale, scale], script, scriptVars, tint })
    const trigger = root.children[0]
    return {
      id: stableId(`template:${name}`),
      name,
      nodeJson: root,
      textureIds: [sprite],
      scripts: {},
      bodies: {},
      // A template carries its triggers in a side map keyed by node id, exactly as it carries bodies.
      triggers: { [trigger.id]: trigger.trigger },
    }
  })
}

/**
 * A pickup is two nodes, and it has to be.
 *
 * The physics world registers `node.body || node.trigger` — one or the other, and the body wins. A
 * single node carrying both would silently never fire, so the trigger lives on its own child. The same
 * script goes on both: the root spins and bobs, the child answers `onTrigger`.
 */
function pickup(name, sprite, options) {
  const trigger = withScript(node('Trigger', 'node', {
    id: stableId(`pickup:${name}:trigger`),
    trigger: { shapes: [{ type: 'sphere', radius: 1.6, offset: [0, 0, 0], rotation: [0, 0, 0] }] },
  }), options.script, options.scriptVars)

  const visual = node(name, 'animatedSprite', {
    id: stableId(`pickup:${name}`),
    position: [0, 0, 0],
    scale: options.scale,
    children: [trigger],
    ...spritePayload(sprite, 'spherical', options.tint),
  })
  // The same script on both halves: the root spins and bobs, the child answers onTrigger. Which half
  // it is running as is decided at runtime by whether the node carries a trigger.
  return withScript(visual, options.script, options.scriptVars)
}

// ---------------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------------

const INK = [0.93, 0.95, 0.98, 1]
const DIM = [0.68, 0.72, 0.8, 1]

function hud() {
  const clock = uiNode('Clock', 'uiText', {
    anchorMin: [0.5, 0], anchorMax: [0.5, 0],
    offsetMin: [-150, 22], offsetMax: [150, 84],
    text: '22:00', fontSize: 46, fontWeight: 700, align: 'center', vAlign: 'middle', tint: INK,
  }, { id: stableId('hud:clock') })

  const score = uiNode('Score', 'uiText', {
    anchorMin: [1, 0], anchorMax: [1, 0],
    offsetMin: [-352, 30], offsetMax: [-32, 70],
    text: '0 / 12', fontSize: 28, fontWeight: 600, align: 'right', vAlign: 'middle', tint: DIM,
  }, { id: stableId('hud:score') })

  const health = uiNode('Health', 'uiProgressBar', {
    anchorMin: [0, 1], anchorMax: [0, 1],
    offsetMin: [32, -58], offsetMax: [372, -30],
    min: 0, max: 100, value: 100,
    fillTint: [0.85, 0.22, 0.2, 1], tint: [0, 0, 0, 0.55],
    direction: 'ltr', smoothing: 0.15, borderRadius: 4,
  }, { id: stableId('hud:health') })

  const pip = (name, fill) => uiNode(name, 'uiProgressBar', {
    offsetMin: [0, 0], offsetMax: [78, 12],
    min: 0, max: 1, value: 1,
    fillTint: fill, tint: [0, 0, 0, 0.5], direction: 'rtl', smoothing: 0, borderRadius: 3,
  }, { id: stableId(`hud:pip:${name}`), visible: false })

  const pips = uiNode('Pips', 'uiStack', {
    anchorMin: [0.5, 0], anchorMax: [0.5, 0],
    offsetMin: [-130, 92], offsetMax: [130, 108],
    direction: 'row', gap: 8, justify: 'center', align: 'center', reverse: false,
  }, {
    id: stableId('hud:pips'),
    children: [
      pip('Speed', [0.35, 0.85, 1, 1]),
      pip('Invincible', [1, 1, 1, 1]),
      pip('Aoe', [1, 0.45, 0.18, 1]),
    ],
  })

  return withScript(uiNode('HUD', 'uiRoot', {
    space: 'screen',
    referenceResolution: [1920, 1080],
    scaleMode: 'scaleWithScreen',
    matchWidthOrHeight: 0.5,
    referenceDpr: 1,
    uiTargetId: null, referenceDistance: 10, minScale: 0.1, maxScale: 4,
    billboard: true, clampToScreen: false, hideBehindCamera: true,
  }, {
    id: stableId('hud'),
    children: [clock, score, health, pips],
  }), 'NightShiftHud')
}

function endScreen() {
  const text = (name, value, size, tint) => uiNode(name, 'uiText', {
    offsetMin: [0, 0], offsetMax: [520, size + 14],
    text: value, fontSize: size, fontWeight: name === 'Title' ? 800 : 500,
    align: 'center', vAlign: 'middle', tint,
  }, { id: stableId(`end:${name}`) })

  const button = (name, label, tint) => uiNode(name, 'uiButton', {
    offsetMin: [0, 0], offsetMax: [200, 56],
    label, disabled: false, tint,
    hoverTint: [1, 1, 1, 0.16], pressedTint: [0, 0, 0, 0.22], disabledTint: [0.5, 0.5, 0.5, 0.4],
    interactive: true, borderRadius: 6,
  }, { id: stableId(`end:btn:${name}`) })

  const buttons = uiNode('Buttons', 'uiStack', {
    offsetMin: [0, 0], offsetMax: [520, 60],
    direction: 'row', gap: 22, justify: 'center', align: 'center', reverse: false,
  }, {
    id: stableId('end:buttons'),
    children: [
      button('Exit', 'Exit', [0.22, 0.24, 0.3, 1]),
      button('Continue', 'Continue', [0.05, 0.42, 0.4, 1]),
    ],
  })

  const card = uiNode('Card', 'uiStack', {
    anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5],
    offsetMin: [-280, -180], offsetMax: [280, 180],
    direction: 'column', gap: 20, justify: 'center', align: 'center', reverse: false,
    tint: [0.06, 0.07, 0.1, 0.92], borderRadius: 10, padding: [28, 28, 28, 28],
  }, {
    id: stableId('end:card'),
    children: [
      text('Title', 'Dawn Breaks', 52, INK),
      text('Items', 'Items   0 / 12', 28, DIM),
      text('Score', 'Score   0', 28, DIM),
      buttons,
    ],
  })

  // Interactive so it swallows clicks that would otherwise reach the world behind it.
  const backdrop = uiNode('Backdrop', 'uiPanel', {
    anchorMin: [0, 0], anchorMax: [1, 1], offsetMin: [0, 0], offsetMax: [0, 0],
    tint: [0, 0, 0, 0.62], interactive: true,
  }, { id: stableId('end:backdrop'), children: [card] })

  // Authored hidden. UI is the one node family that persists `visible`, which is what makes this work.
  return withScript(uiNode('EndScreen', 'uiRoot', {
    space: 'screen',
    referenceResolution: [1920, 1080],
    scaleMode: 'scaleWithScreen',
    matchWidthOrHeight: 0.5,
    referenceDpr: 1,
    uiTargetId: null, referenceDistance: 10, minScale: 0.1, maxScale: 4,
    billboard: true, clampToScreen: false, hideBehindCamera: true,
    zOrder: 100,
  }, {
    id: stableId('end'),
    visible: false,
    children: [backdrop],
  }), 'NightShiftEndScreen')
}

// ---------------------------------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------------------------------

function nightScene() {
  // Reused wholesale from the 3d-example: terrain, sky, clouds, indirect light and the house that gives
  // the zombies something to lose sight of you behind.
  const landscape = sourceNode('Landscape')
  const clouds = sourceNode('volumetric clouds')
  const sky = sourceNode('sky atmosphere')
  const house = sourceNode('Wood_house')

  // NO LIGHT PROBE, deliberately, and this is not an oversight.
  //
  // A probe supplies split-sum IBL for every pixel inside its volume, and where it applies it REPLACES
  // the flat scene ambient rather than adding to it. The 3d-example's probe is a 50x50x40 box with a
  // 40-unit blend sitting right where the player spawns.
  //
  // Worse, a probe with `mode: 'baked'` and no stored maps re-bakes itself on its first frame — which
  // here is the middle of the night. It captures a black sky, and every pixel it covers is then lit by
  // that black capture for the rest of the level, with the scene ambient overridden. The level is
  // pitch dark and nothing you do to `ambientLight` changes it.
  //
  // A statically baked probe is the wrong tool for a level whose lighting sweeps from night to day: its
  // premise is that indirect light does not change. Bake one per level state, or leave it out.
  // The director rotates this, so it must be findable by name.
  const sun = sourceNode('light')
  sun.name = 'Sun'

  const playable = sourceNode('Playable')
  playable.position = [0, 3.2, 0]
  withScript(playable, 'NightShiftPlayer')
  const pivot = playable.children.find(c => c.name === 'camera rig')
  if (pivot) withScript(pivot, 'ThirdPersonCameraPivot')
  // The placed instance carries its own inline copy of the subtree — it does not read the template at
  // load — so the controller has to be added here as well as to the template.
  playable.children.push(playerController(playable.id, stableId('scene:player:controller')))

  for (const id of ['0694051b-2680-4e7f-a583-e761ed33fc1c', 'd41ce5bf-28e5-4a58-969a-40cd73a6f44f',
    '3fa150eb-400f-4ead-8ce1-7c1459f2c60d', 'Null', '__editor__light_icon',
    'Wood_house_BaseColor.1001.jpg', 'Wood_house_Normal.1001.jpg', 'Wood_house_Roughness.1001.jpg',
    'Wood_house_Metallic.1001.jpg', 'Wood_house_Displacement.1001.jpg',
    'forrest_ground_01_diff_1k.png', 'forrest_ground_01_arm_1k.png', 'forrest_ground_01_nor_gl_1k.png',
    'forrest_ground_01_ao_1k.png', 'forrest_ground_01_disp_1k.png', 'forrest_ground_01_rough_1k.png',
    'forest_ground_06_diff_1k.png', 'forest_ground_06_arm_1k.png', 'forest_ground_06_nor_gl_1k.png',
    'forest_ground_06_ao_1k.png', 'forest_ground_06_disp_1k.png', 'forest_ground_06_rough_1k.png',
  ]) textures.copy(id)

  const director = withScript(node('GameManager', 'node', { id: stableId('director') }),
    'NightShiftDirector', { itemsTotal: 12, levelSeconds: 180 })

  // One spawner each, and no authored spawn points on either. Both ask the director for a random spot
  // on walkable terrain instead, which is what keeps them off the roof of the house.
  const spawner = withScript(node('ZombieSpawner', 'node', { id: stableId('spawner') }),
    'NightShiftSpawner')

  const pickupSpawner = withScript(node('PickupSpawner', 'node', { id: stableId('pickup-spawner') }),
    'NightShiftPickupSpawner', { scoreCount: 12 })

  // Authored but unbaked: `path` and `patrol` fall back to a straight-line seek until someone presses
  // Bake, so the level is playable either way and gets better the moment it is baked.
  const navMesh = node('Nav Mesh', 'navMesh', {
    id: stableId('navmesh'),
    bake: {}, agentRadius: 0.45,
  })

  const root = node('root', 'node', {
    id: stableId('root'),
    children: [
      director, spawner, playable, sun, sky, clouds, landscape, house,
      navMesh, pickupSpawner, hud(), endScreen(),
    ],
    // LUX, not a 0..1 colour: REFERENCE_ILLUMINANCE is 78643 and the engine's own default ambient is
    // a tenth of it. This is the director's night value, so the editor viewport matches frame one.
    ambientLight: [3224, 3539, 4522],
  })

  const config = JSON.parse(JSON.stringify(sourceScene.config))
  // Night: a dark ground colour and a low starting exposure. The director lifts exposure toward dawn.
  config.graphics.clearColor = [0.02, 0.03, 0.06, 1]
  config.render.clearColor = [0.02, 0.03, 0.06, 1]
  // Open, not stopped down: there is far less light at night, so the exposure has to compensate. The
  // director ramps all three toward dawn.
  config.render.exposure = 1.6
  config.render.vignetteStrength = 0.4
  config.render.saturation = 0.55

  // Metering, on a short leash. The band is a CEILING on brightness as much as a floor on EV: the
  // engine's default `exposureMinEV` of 2 is an exposure of 16384, so a scene merely meant to LOOK dark
  // gets normalised into a white screen. 14.5 brackets the authored 1.6, and the night compensation
  // keeps the picture a stop under whatever was metered.
  //
  // Authored here as well as set by the director, because the director only runs in Play — the editor
  // viewport renders these, and a viewport that blows out is just as broken.
  config.render.autoExposureEnabled = true
  config.render.exposureMinEV = 14.5
  config.render.exposureMaxEV = 16.5
  config.render.exposureCompensation = -1
  config.render.exposureSpeedUp = 0.6
  config.render.exposureSpeedDown = 0.6

  return sceneFile(root, config)
}

function menuScene() {
  const title = uiNode('Title', 'uiText', {
    anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5],
    offsetMin: [-420, -190], offsetMax: [420, -90],
    text: 'NIGHT SHIFT', fontSize: 92, fontWeight: 800, align: 'center', vAlign: 'middle', tint: INK,
  }, { id: stableId('menu:title') })

  const blurb = uiNode('Blurb', 'uiText', {
    anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5],
    offsetMin: [-460, -70], offsetMax: [460, 30],
    text: 'Scavenge the forest before dawn.\nThe dead do not like the sun.',
    fontSize: 26, align: 'center', vAlign: 'middle', wrap: true, lineHeight: 1.5, tint: DIM,
  }, { id: stableId('menu:blurb') })

  // No script: the Play button is wired in the editor, because a menu is the one place a designer will
  // certainly want to change the wording and the target scene without opening a file.
  const play = uiNode('Play', 'uiButton', {
    anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5],
    offsetMin: [-120, 70], offsetMax: [120, 130],
    label: 'Play', disabled: false, interactive: true,
    tint: [0.05, 0.42, 0.4, 1], hoverTint: [1, 1, 1, 0.16], pressedTint: [0, 0, 0, 0.22],
    disabledTint: [0.5, 0.5, 0.5, 0.4], borderRadius: 6,
  }, { id: stableId('menu:play') })

  const root = node('root', 'node', {
    id: stableId('menu:root'),
    children: [
      uiNode('Menu', 'uiRoot', {
        space: 'screen', referenceResolution: [1920, 1080], scaleMode: 'scaleWithScreen',
        matchWidthOrHeight: 0.5, referenceDpr: 1,
        uiTargetId: null, referenceDistance: 10, minScale: 0.1, maxScale: 4,
        billboard: true, clampToScreen: false, hideBehindCamera: true,
      }, { id: stableId('menu:root:ui'), children: [title, blurb, play] }),
    ],
    ambientLight: [3200, 3200, 5100],
  })

  const config = JSON.parse(JSON.stringify(sourceScene.config))
  config.graphics.clearColor = [0.02, 0.02, 0.04, 1]
  config.render.clearColor = [0.02, 0.02, 0.04, 1]
  return sceneFile(root, config)
}

function sceneFile(root, config) {
  return {
    scene: root,
    textures: [],
    // Legacy overlay UI. Empty: this project's UI is nodes.
    ui: { version: 1, elements: [] },
    config,
    assetHashes: {},
    assetHashVersion: 2,
    savedAt: CREATED_AT,
  }
}

// ---------------------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------------------

function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(path.join(OUT, 'libraries'), { recursive: true })
  fs.mkdirSync(path.join(OUT, 'scenes'), { recursive: true })

  const { template: zombie } = zombieTemplate()
  const night = nightScene()
  const menu = menuScene()

  const models = sourceModels.filter(m => m.id === MANNEQUIN_MODEL)
  if (models.length !== 1) throw new Error('the mannequin model is not in the 3d-example library')

  const libraries = {
    models,
    materials: sourceMaterials.filter(m => m.name !== 'torch blinn_phong'),
    terrainMaterials: sourceTerrainMats,
    animationFields: sourceFields.filter(f => f.id === LOCOMOTION_FIELD),
    tilesets,
    scripts: scripts.assets,
    templates: [playableTemplate, zombie, ...pickupTemplates()],
  }
  for (const [name, value] of Object.entries(libraries))
    writeJson(path.join(OUT, 'libraries', `${name}.json`), value)

  writeJson(path.join(OUT, 'scenes', `${NIGHT_SCENE}.json`), night)
  writeJson(path.join(OUT, 'scenes', `${MENU_SCENE}.json`), menu)

  const textureCount = textures.write(OUT)

  writeJson(path.join(OUT, 'manifest.json'), {
    formatVersion: 1,
    kind: 'project',
    createdAt: CREATED_AT,
    projectName: 'Night Shift',
    mainSceneId: NIGHT_SCENE,
    openSceneId: NIGHT_SCENE,
    sceneMetas: [
      {
        id: NIGHT_SCENE, name: 'Night Shift', updatedAt: CREATED_AT, dimension: '3D',
        refs: {
          materialIds: libraries.materials.map(m => m.id),
          modelIds: [MANNEQUIN_MODEL],
          templateIds: libraries.templates.map(t => t.id),
          terrainMaterialIds: sourceTerrainMats.map(m => m.id),
          tilesetIds: tilesets.map(t => t.id),
          textureIds: textures.included,
        },
      },
      {
        id: MENU_SCENE, name: 'Main Menu', updatedAt: CREATED_AT, dimension: '3D',
        refs: {
          materialIds: [], modelIds: [], templateIds: [], terrainMaterialIds: [],
          tilesetIds: [], textureIds: [],
        },
      },
    ],
  })

  writeJson(path.join(OUT, 'vfs.json'), vfs(libraries))
  writeJson(path.join(OUT, 'example.json'), {
    name: 'Night Shift',
    description: 'A third-person survival night: collect before dawn, and stay ahead of what the dark brings.',
    order: 1,
  })

  report({ zombie, libraries, textureCount })
}

function vfs(libraries) {
  const entries = [
    { path: '/Night Shift.scene', kind: 'scene', assetId: NIGHT_SCENE, created: CREATED_AT },
    { path: '/Main Menu.scene', kind: 'scene', assetId: MENU_SCENE, created: CREATED_AT },
  ]
  const add = (folder, kind, items) => {
    for (const item of items)
      entries.push({ path: `${folder}/${item.name}.${kind}`, kind, assetId: item.id, created: CREATED_AT })
  }
  add('/Scripts', 'script', libraries.scripts)
  add('/Templates', 'template', libraries.templates)
  add('/Models', 'model', libraries.models)
  add('/Materials', 'material', libraries.materials)
  add('/Materials', 'terrainMaterial', libraries.terrainMaterials)
  add('/Sprites', 'tileset', libraries.tilesets)
  add('/Animation', 'animationField', libraries.animationFields)

  return {
    version: 1,
    folders: ['/Scripts', '/Templates', '/Models', '/Materials', '/Sprites', '/Animation'],
    entries,
  }
}

/** The Zombie template's own model, for the summary. */
function zombieModelNode(zombie) {
  return zombie.nodeJson.children.find(c => c.type === 'model')
}
const zombieClipCount = (z) => zombieModelNode(z).model.animations.length
const zombieMaterialCount = (z) => (zombieModelNode(z).model.materials ?? [1]).length

function report({ zombie, libraries, textureCount }) {
  const size = (file) => fs.statSync(path.join(OUT, file)).size
  const total = walkSize(OUT)

  console.log('Night Shift written to editor/public/examples/night-shift/')
  console.log('')
  console.log('  scenes      Night Shift  %s', mb(size(`scenes/${NIGHT_SCENE}.json`)))
  console.log('              Main Menu    %s', mb(size(`scenes/${MENU_SCENE}.json`)))
  console.log('  libraries   models       %s', mb(size('libraries/models.json')))
  console.log('              templates    %s  (Playable + Zombie)', mb(size('libraries/templates.json')))
  console.log('              scripts      %d assets', libraries.scripts.length)
  console.log('              tilesets     %d', libraries.tilesets.length)
  console.log('  textures    %d payloads   %s', textureCount, mb(textures.bytes))
  console.log('')
  console.log('  the Zombie carries its own model: %d clips, %d material tiles',
    zombieClipCount(zombie), zombieMaterialCount(zombie))
  console.log('  TOTAL %s', mb(total))
  console.log('')
  console.log('Next:  npm --prefix editor run examples:list')
}

function walkSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? walkSize(full) : fs.statSync(full).size
  }
  return total
}

main()
