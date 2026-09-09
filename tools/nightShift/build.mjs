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
// none of that is needed, because every mesh, skeleton and texture here is either copied from a project
// that already imported them or read out of a committed intermediate. The .fbx conversions live in
// `importZombie.mjs` (the character) and `importClips.mjs` (both characters' clips), which are run BY
// HAND when the art changes and whose output is committed — `build/` is gitignored, so it cannot be a
// build input. The only other new art is three sprite atlases, packed offline by `packSprites.py`.
//
// ## Where the shapes come from
//
// The editor's own modules are loaded and run rather than restated: `storeSkin` for the skeleton the
// rigs store, and `KIND_EXT` / `ASSET_HASH_VERSION` / `SCENE_REFS_VERSION` for the three stamps a
// generated project carries. Copying those is how this file came to write `.animationField` — an
// extension the asset explorer cannot classify — and an `assetHashVersion` four versions stale.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { TextureSet, loadScriptReflector, mb, node, readJson, stableId, uiNode, vars, writeJson }
  from './bundle.mjs'
import { editorModules } from './fbxImport.mjs'
import { moduleRegistry } from './tsLoader.mjs'
import { ASSET_HASH_VERSION, KIND_EXT, SCENE_REFS_VERSION } from './editorConstants.mjs'

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

// The zombie's own model, converted offline from `build/Zombie/Zombie.fbx` by `importZombie.mjs`, and
// its clips by `importClips.mjs`. Both are committed: `build/` is gitignored, so the .fbx files cannot be
// a build input — the example has to regenerate byte-identically on a clean checkout.
//
// The PLAYER imports nothing. Its 17 clips are the ones already baked into the 3d-example mannequin,
// read straight off that model asset — see `buildRigsAndAnimations`.
const ZOMBIE_MODEL = path.join(HERE, 'zombieModel.json')
const ZOMBIE_CLIPS = path.join(HERE, 'zombieClips.json')
const ZOMBIE_TEXTURES = path.join(HERE, 'zombie')

// `storeSkin` out of the editor's own sources — see fbxImport.mjs for why this is loaded rather than
// restated. It is also what strips `ikRig` from the copy a rig keeps; see `buildRigsAndAnimations`.
const { storeSkin } = editorModules(ROOT)

// The blend-space helpers, likewise run rather than restated — `toRuntimeField` decides what an
// AnimationState embeds, and its one subtlety (drop `yAxis` in 1D mode, or an untouched hidden axis makes
// every embedded copy look changed) is exactly the kind of rule a second implementation loses.
// animationFields.ts names three engine classes, but only as `instanceof` targets inside a helper this
// never calls, so stubs satisfy the module graph without dragging a renderer into Node.
const { buildAnimationFieldAsset, toRuntimeField } = moduleRegistry({
  cleo: { Node: class {}, ModelNode: class {}, AnimatedModel: class {} },
  './ids': { cryptoRandomId: () => { throw new Error('ids must be stable in a generator') } },
})(path.join(ROOT, 'editor', 'src', 'utils', 'animationFields.ts'))

/**
 * The zombie's two gaits, in metres per second.
 *
 * Named once because THREE things have to agree on them: the character node's `walkSpeed`/`runSpeed`, the
 * blend space's sample coordinates, and its axis maximum. That agreement is the whole idiom — the player's
 * field does the same, placing `Walk` at 1.5 and `Run` at 4 to match its character. Let them drift and the
 * character reaches a speed the field has no sample for, which reads as a gait that never fully arrives.
 */
const ZOMBIE_WALK_SPEED = 1.1
const ZOMBIE_RUN_SPEED = 2.4

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

/** The player's character, and the only model this project copies out of 3d-example. */
const mannequin = sourceModels.find(m => m.id === MANNEQUIN_MODEL)
if (!mannequin) throw new Error('the mannequin model is not in the 3d-example library')

/**
 * Every sub-mesh in a serialized subtree that carries a skeleton — `skinnedModelJsonsOf` in
 * editor/src/utils/modelClips.ts, which is what the editor's own migrations walk with.
 */
function skinnedModelJsons(nodeJson) {
  const out = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.model?.skin) out.push(n.model)
    for (const child of n.children ?? []) walk(child)
  }
  walk(nodeJson)
  return out
}

/**
 * Remove every clip embedded in a subtree, in place, and report how many went.
 *
 * `null` rather than `[]`, because that is what `AnimatedModel.serialize` writes for a model with no
 * clips and `assetWithClipRemoved` already normalises to.
 *
 * This is what makes rig-owned clips work at all. `refreshModelClips` re-pushes whatever is in
 * `nodeJson.animations` and THEN layers the rig's on top, so a clip left in both places comes back from
 * `addAnimation`'s de-dupe as `Idle (2)` — a name no state machine and no blend-space sample says. The
 * character silently stops animating, and the only trace is a per-frame "model does not have clip Idle".
 *
 * The `skin` stays: `Model.parse` needs it at parse time, and the mannequin's carries the hand-authored
 * foot-IK rig.
 */
function stripEmbeddedClips(nodeJson) {
  let removed = 0
  for (const model of skinnedModelJsons(nodeJson)) {
    removed += model.animations?.length ?? 0
    model.animations = null
  }
  return removed
}

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
// Rigs, clips and models
// ---------------------------------------------------------------------------------------------------

/** The zombie's mesh, skeleton and materials as `importZombie.mjs` baked them. Clips are NOT included. */
function zombieModelPayload() {
  if (!fs.existsSync(ZOMBIE_MODEL)) {
    throw new Error(`missing ${path.relative(ROOT, ZOMBIE_MODEL)} — run: `
      + 'node --max-old-space-size=8192 tools/nightShift/importZombie.mjs')
  }
  const payload = readJson(ZOMBIE_MODEL)
  // Explicitly EMPTY, not absent. `AnimatedModel.serialize` writes `null` for a model with no clips, and
  // the importer simply omits the key — so without this one character in the project answers "does this
  // model embed clips?" with `undefined` while every other answers `null`. Both parse the same; only one
  // of them is what a reader checking the invariant sees.
  payload.animations = null
  return payload
}

/** A committed clip set, with the tool that produces it named in the failure. */
function clipSet(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${path.relative(ROOT, file)} — run: `
      + 'node tools/nightShift/importClips.mjs')
  }
  return readJson(file)
}

/**
 * The two skeletons, and the clip library they own between them.
 *
 * ## Why there are two rigs and not one
 *
 * Both characters are standard 66-bone Mixamo humanoids, but they are different exports of different
 * bodies: the mannequin's bones are namespaced `mixamorig1:` and the zombie's `mixamorig5:`, and the two
 * bind poses genuinely differ — the zombie is the shorter of the two. `skeletonFingerprint` is a
 * function of the bind matrices, so it separates them, and it is right to: collapsing them onto one rig
 * would make every clip play at one character's proportions.
 *
 * ## Why both rigs then own EVERY clip
 *
 * Because a rig's clip list is what `normalizeBoneName` makes portable. It strips the `mixamorigN:`
 * namespace, so a curve authored on either skeleton matches the other by bone name, and the retarget
 * between them is a proportion rebase rather than a translation. Linking both lists to every clip is
 * therefore the whole point of the rig work: the zombie can play the player's locomotion and the player
 * can play the zombie's, without either file being duplicated or re-imported.
 *
 * ## Why the zombie's five clips are PREFIXED
 *
 * `AnimationState.clipName` is a string resolved against the live model, and both characters were
 * authored with an `Idle` and a `Walk`. Sharing one clip set makes those collide, and the collision does
 * not raise: `AnimatedModel.addAnimation` de-dupes the loser to `Idle (2)`, which no state machine names.
 * So the zombie's are `Zombie Idle`, `Zombie Walk`, `Zombie Running`, `Zombie Attack` and
 * `Zombie Dying` — the names of the .fbx files they came from — and its state machine says those. The
 * mannequin's 17 keep the names the Playable machine and the `Playable Field` blend space already use.
 */
function buildRigsAndAnimations() {
  const mannequinSkin = skinnedModelJsons(mannequin.nodeJson)[0]?.skin
  if (!mannequinSkin) throw new Error('the mannequin model asset carries no skeleton')

  /**
   * The player's clips, exactly as 3d-example baked them: 17, covering every `Playable Field` sample plus
   * `Idle`, `Jump`, `T-Pose` and the four root-motion turns.
   *
   * They were briefly re-imported from `build/Locomotion Pack/` instead. That import was more faithful —
   * it kept the authored travel a Mixamo download carries, where these had theirs destroyed by an old
   * retarget bug — but faithful is the wrong thing here: the player's gait plays through a blend FIELD,
   * and a field never reaches the root-motion path, so authored travel goes straight into the pose and
   * drags the mesh off its own capsule. These are in-place already, which is what the field wants.
   */
  const baked = skinnedModelJsons(mannequin.nodeJson)[0].animations ?? []
  if (!baked.length) throw new Error('the mannequin model asset carries no clips')

  // `storeSkin` normalises and, in doing so, drops `ikRig`. That is deliberate: the foot-IK setup stays
  // on the model's own embedded skin, which is where `commitIkRig` reads and writes it. A second copy on
  // the rig would be written by nothing and read by nothing, and would go stale the first time anyone
  // moved a bone.
  const rigs = [
    { id: stableId('rig:mannequin'), name: 'Mannequin', skin: storeSkin(mannequinSkin) },
    { id: stableId('rig:zombie'), name: 'Zombie', skin: storeSkin(zombieModelPayload().skin) },
  ]
  const [mannequinRig, zombieRig] = rigs

  const animations = []
  const addClips = (clips, rig) => clips.map(clip => {
    const asset = {
      id: stableId(`anim:${clip.name}`),
      name: clip.name,
      clips: [clip],
      rigId: rig.id,
      // Kept alongside `rigId`, never instead of it. `sourceSkinFor` prefers the rig, but this is the
      // fallback if the rig is ever deleted, and `player/animations.ts` reads it directly — an asset
      // with neither plays UNRETARGETED, which looks like a broken character rather than a missing one.
      sourceSkin: rig.skin,
    }
    animations.push(asset)
    return asset.id
  })

  const mannequinIds = addClips(baked, mannequinRig)
  const zombieIds = addClips(clipSet(ZOMBIE_CLIPS), zombieRig)

  const names = animations.map(a => a.name)
  const clash = names.find((n, i) => names.indexOf(n) !== i)
  if (clash) throw new Error(`two animation assets are both called "${clash}" — see addAnimation's de-dupe`)

  const everyClip = [...mannequinIds, ...zombieIds]
  for (const rig of rigs) rig.animationIds = everyClip

  return { rigs, animations, mannequinRig, zombieRig }
}

const { rigs, animations, mannequinRig, zombieRig } = buildRigsAndAnimations()

/**
 * The zombie's gait as a 1D blend space, replacing the Idle/Walk state ladder it used to have.
 *
 * ## Why a field rather than more states
 *
 * A ladder switches; a field BLENDS. With discrete states the zombie snapped between a 4-second shamble
 * and a 0.8-second run at whatever threshold was authored, and every speed in between looked like one or
 * the other. Sampling by measured speed instead means the gait is continuous, and the thresholds — the
 * part that was actually wrong, see the `Idle` behaviour state — stop existing at all.
 *
 * ## Why the samples sit on the character's own speeds
 *
 * This is the player's idiom: its `Playable Field` places `Walk` at 1.5 and `Run` at 4, which are exactly
 * its `walkSpeed` and `runSpeed`. A sample coordinate is the speed at which that clip is the whole answer,
 * so it has to be a speed the character can actually reach — hence the shared constants.
 *
 * Owned by the RIG, like every field now, so any character on this skeleton can play it.
 */
const zombieGait = (() => {
  const asset = buildAnimationFieldAsset('Zombie Gait', zombieRig.id, stableId('afield:zombie-gait'))
  asset.xAxis = { name: 'Speed', min: 0, max: ZOMBIE_RUN_SPEED, smoothing: 0.04 }
  asset.samples = [
    // Idle is IN the field at zero rather than a separate state, so standing still is the same blend as
    // everything else and there is no entry threshold to cross.
    { clipName: 'Zombie Idle', x: 0 },
    { clipName: 'Zombie Walk', x: ZOMBIE_WALK_SPEED },
    { clipName: 'Zombie Running', x: ZOMBIE_RUN_SPEED },
  ]
  asset.weightSmoothing = 0.06
  return asset
})()

/**
 * The player's blend space, carried over from 3d-example and re-pointed at the mannequin's rig.
 *
 * Hoisted to module scope because it is needed TWICE and the two copies must agree: the library ships the
 * asset, and `playableStateMachine` embeds a runtime copy of it inside the state that plays it. A state
 * resolves `fieldId` against nothing at runtime — the embedded `field` is what actually plays — so an
 * asset edit that did not reach the embedded copy would change the editor's view and nothing else.
 */
const playableField = (() => {
  const source = sourceFields.find(f => f.id === LOCOMOTION_FIELD)
  if (!source) throw new Error('the Playable Field is not in the 3d-example library')
  // `modelId` is dropped rather than kept alongside `rigId`: two keys would leave two answers to "what
  // does this field blend", and the v4 migration drops it for the same reason.
  const { modelId, ...field } = source
  return { ...field, rigId: mannequinRig.id }
})()

/**
 * The two model assets.
 *
 * Both come back with their embedded clips stripped and a `rigId` in their place. The zombie is a model
 * asset here for the first time — it used to exist only as a subtree inside its own template, with
 * `__modelId: null` — which is what lets the enemies appear in the asset explorer, pick up a material or
 * mesh edit, and reach a rig at all.
 */
function buildModels() {
  const player = JSON.parse(JSON.stringify(mannequin))
  stripEmbeddedClips(player.nodeJson)
  player.rigId = mannequinRig.id

  const payload = zombieModelPayload()
  const zombie = {
    id: stableId('model:zombie'),
    name: 'Zombie',
    // The holder-plus-sub-mesh shape every model asset has: a plain `node` carrying one `model` child.
    // One child, not two, even though the character is two material tiles — they are two SUBMESH ranges
    // over one buffer, which is what `model.materials` and `model.submeshes` describe.
    nodeJson: node('Zombie', 'node', {
      id: stableId('model:zombie:root'),
      children: [node('Ch10', 'model', { id: stableId('model:zombie:mesh'), model: payload })],
    }),
    // The two UDIM tiles' maps. Its materials are INLINE — they are not library assets, so there is no
    // `materialIds` to list and no `__materialId` on the node.
    materialIds: [],
    textureIds: ZOMBIE_MAPS.map(([id]) => id),
    // No thumbnail: the generator has no GL context to render one, and the explorer falls back to the
    // kind's icon. Minting a placeholder would only look like a broken render.
    thumbnail: '',
    rigId: zombieRig.id,
  }

  return [player, zombie]
}

const models = buildModels()
const zombieModelAsset = models[1]

// ---------------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------------

const playableTemplate = JSON.parse(JSON.stringify(
  sourceTemplates.find(t => t.name === 'Playable')))
// The template embeds its own copy of the subtree, so its clips have to go too — see stripEmbeddedClips.
// It keeps its `__modelId`, which is how the character finds the model asset that names the rig.
stripEmbeddedClips(playableTemplate.nodeJson)

/**
 * The player's animation machine, authored here rather than inherited from 3d-example.
 *
 * What it replaces was two states — an idle and the blend space — on one speed threshold, which is why
 * the mannequin owned four turn clips that nothing ever played.
 *
 * ## Everything below is already computed every frame; none of it needed a script
 *
 * `CharacterNode` publishes `turnRequest` as a plain field, and `_refreshVariableParams`
 * reads the `variables` map first and then a native own property — so a `variable` parameter binds
 * straight to them. `ThirdPersonPlayable`'s header has documented this exact wiring all along.
 *
 * ## The turn contract, which is easy to get backwards
 *
 * While the character is idle and facing its AIM, `stepLocomotion` latches a turn once the camera swings
 * `turnThreshold` (90 deg) off the body, and releases it under `turnReleaseAngle` (10 deg). It publishes
 * a CLIP SELECTOR, not an angle: +1/+2 right, -1/-2 left, 2 past 135 deg. The body does not rotate on its
 * own here at all — the turn clip's ROOT MOTION rotates it, which is why those four are the only clips
 * that keep their travel. Wire the sign backwards and the root motion drives the body AWAY from the aim,
 * the release angle is never reached, and the machine ping-pongs on one side of centre forever.
 */
function playableStateMachine() {
  const speed = (op, value) => ({ op: 'and', children: [{ param: 'Speed', op, value, hysteresis: 0.1 }] })
  /** A one-shot: plays once, then hands back on exit time alone. */
  const oneShot = (name, clipName, x, y) =>
    ({ name, clipName, loop: false, speed: 1, isEntry: false, x, y })
  /** The return edge. No condition at all — an empty flat list is vacuously true, so exit time is the rule. */
  const whenFinished = (from, to) =>
    ({ from, to, conditions: [], minDwell: 0, hasExitTime: true, exitTime: 1 })

  return {
    parameters: [
      // planarSpeed, NOT currentSpeed. `currentSpeed` is the full 3D magnitude and a jump inflates it, so
      // the copied machine read a fall as a sprint and flipped its own locomotion gate in mid-air.
      {
        name: 'Speed', type: 'variable', default: 0,
        variable: { nodeRef: 'parent', varName: 'planarSpeed', varType: 'number', source: 'builtin' },
      },
      {
        name: 'Direction', type: 'variable', default: 0,
        variable: { nodeRef: 'parent', varName: 'planarAngle', varType: 'number', source: 'builtin' },
      },
      // A native CharacterNode field rather than a builtin — see the header. `source: 'variable'` is what
      // takes the own-property path.
      {
        name: 'Turn', type: 'variable', default: 0,
        variable: { nodeRef: 'parent', varName: 'turnRequest', varType: 'number', source: 'variable' },
      },
    ],
    states: [
      { name: 'Idle', clipName: 'Idle', loop: true, speed: 1, isEntry: true, x: 40, y: 40 },
      {
        name: 'Locomotion', clipName: '', fieldId: LOCOMOTION_FIELD,
        field: toRuntimeField(playableField), fieldInputs: { x: 'Direction', y: 'Speed' },
        loop: true, speed: 1, isEntry: false, x: 300, y: 40,
      },
      oneShot('Turn90Right', 'Turn90Right', -190, -60),
      oneShot('Turn90Left', 'Turn90Left', -190, 20),
      oneShot('Turn180Right', 'Turn180Right', -190, 100),
      oneShot('Turn180Left', 'Turn180Left', -190, 180),
    ],
    // ORDER MATTERS: the scan takes the first satisfied edge and stops.
    transitions: [
      {
        from: 'Idle', to: 'Locomotion', conditions: [], minDwell: 0.1, hasExitTime: false, exitTime: 1,
        condition: speed('gt', 1.2),
      },
      {
        from: 'Locomotion', to: 'Idle', conditions: [], minDwell: 0.1, hasExitTime: false, exitTime: 1,
        condition: speed('lt', 1.2),
      },

      // The four turns. `eq` is exact equality and takes no hysteresis, which is right — locomotion has
      // already latched the code and holds it for the whole turn.
      ...[['Turn90Right', 1], ['Turn90Left', -1], ['Turn180Right', 2], ['Turn180Left', -2]].flatMap(
        ([state, code]) => [
          {
            from: 'Idle', to: state, conditions: [], minDwell: 0, hasExitTime: false, exitTime: 1,
            condition: { op: 'and', children: [{ param: 'Turn', op: 'eq', value: code }] },
          },
          whenFinished(state, 'Idle'),
        ]),
    ],
    events: [],
  }
}

/**
 * Put the authored machine on a Playable subtree, and give the character the deceleration it needs.
 *
 * Applied to the template AND to the placed scene instance, which carry independent inline copies — a
 * machine written to only one of them leaves the other on whatever 3d-example shipped.
 *
 * `acceleration` defaults to 0, meaning the commanded velocity SNAPS to zero the moment a key is
 * released — the character reaches full sprint and full stop within one frame, so the blend space jumps
 * between its samples instead of travelling through them. A real ramp is what makes the gait read as
 * acceleration rather than as a switch.
 */
function withPlayerAnimation(playableNode) {
  playableNode.acceleration = 10
  const model = playableNode.children.find(c => c.name === 'Ch36')
  if (!model) throw new Error('the Playable subtree has no Ch36 model node to animate')
  model.stateMachine = playableStateMachine()
  return playableNode
}

withPlayerAnimation(playableTemplate.nodeJson)

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
 * character in two material tiles, with five clips authored for it. The mannequin stays where it
 * belongs, on the player.
 *
 * The subtree here is INLINE, as every template's is — a placed instance does not read the library at
 * load. What is new is that it also names a model asset, so the two stay linked; see `buildModels`.
 */
function zombieTemplate() {
  const payload = zombieModelPayload()

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
    // The link back to the `Zombie` model asset. Without it the placed character is an orphaned skinned
    // subtree: the asset explorer shows no model behind the enemies, nothing propagates a mesh or
    // material edit to them, and — since the RIG is reached through the model — the clip set they play
    // has no owner to come from.
    variables: vars({ __modelId: zombieModelAsset.id }),
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
    // Both reachable now: `NightShiftZombie` sets `sprint` while hunting, which is what selects runSpeed
    // over walkSpeed. Before that the AI had no way to ask for it — a behaviour state's `speedScale` is
    // clamped to 0..1 and can only throttle DOWN — so runSpeed was authored here and never used.
    walkSpeed: ZOMBIE_WALK_SPEED,
    runSpeed: ZOMBIE_RUN_SPEED,
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
      // Full walk pace, not a drift. At the old 0.3 a wandering zombie measured 0.33 m/s while its own
      // Idle->Walk threshold engaged at 0.45 (hysteresis is CENTRED), so it never left the idle clip and
      // slid across the ground. Wander now moves at what used to be chase speed; chase sprints past it.
      { name: 'Idle', goal: 'wander', speedScale: 1, isEntry: true, x: 40, y: 40 },
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
      // Likewise an event, fired by the script as it starts a swing. NOT derived from the behaviour
      // machine's `Attack` state: that state is entered and left by distance alone, with no minDwell, so
      // a player hovering at the 1.6-2.0 m band would re-enter it every few frames and restart the clip.
      { name: 'Attacked', type: 'trigger', default: false },
    ],
    states: [
      // ONE locomotion state, blending idle -> shamble -> run by measured speed. The clip names carry the
      // `Zombie` prefix because the two rigs share a clip set and both characters were authored with an
      // `Idle` and a `Walk` — see buildRigsAndAnimations for why that collision is silent rather than loud.
      {
        name: 'Locomotion',
        // Empty, and required to be: `clipName` is ignored once `field` is set, but the parser reads it
        // unguarded. The field is what plays.
        clipName: '',
        fieldId: zombieGait.id,
        // BOTH the link and an embedded copy. `field` is what the runtime reads, and embedding is what
        // carries the blend space through a save, a template instantiation and the published build —
        // none of which can resolve `fieldId` against a library.
        field: toRuntimeField(zombieGait),
        fieldInputs: { x: 'Speed' },
        loop: true, speed: 1, isEntry: true, x: 40, y: 40,
      },
      // One swing, then back to the gait. The clip is 4.63 s but only its first 2.7 s is animation —
      // wind-up to 1.0 s, strike through 1.75 s, recovery to ~2.7 s, then two seconds of near-static
      // settle. `exitTime` cuts the tail and `speed` tightens the whole thing to about 1.8 s, which has
      // to stay under NightShiftZombie's `attackCooldown` or the next trigger is raised while the machine
      // is still in this state — where nothing consumes it, and it fires again the instant we leave.
      { name: 'Attack', clipName: 'Zombie Attack', loop: false, speed: 1.5, isEntry: false, x: 300, y: 130 },
      // No loop and no way out: the collapse plays once and the pose holds until the ragdoll takes the
      // skeleton over. `minDwell: 0` on the way in, because a zombie that finished burning should not
      // keep shambling for another sixth of a second.
      { name: 'Dying', clipName: 'Zombie Dying', loop: false, speed: 1, isEntry: false, x: 150, y: 200 },
    ],
    transitions: [
      {
        from: 'Locomotion', to: 'Attack', conditions: [], minDwell: 0, hasExitTime: false, exitTime: 1,
        condition: { op: 'and', children: [{ param: 'Attacked', op: 'trigger' }] },
      },
      // Back to the gait once the swing has played. No condition at all: an empty flat list is vacuously
      // true, so the exit-time gate is the whole rule. 0.58 of 4.63 s is the end of the recovery.
      {
        from: 'Attack', to: 'Locomotion', conditions: [], minDwell: 0, hasExitTime: true, exitTime: 0.58,
      },
      // Death has to reach the machine from BOTH alive states — a zombie set alight mid-swing must still
      // collapse, and a wildcard `from` would also match Dying itself, which has no way back.
      {
        from: 'Locomotion', to: 'Dying', conditions: [], minDwell: 0, hasExitTime: false, exitTime: 1,
        condition: { op: 'and', children: [{ param: 'Died', op: 'trigger' }] },
      },
      {
        from: 'Attack', to: 'Dying', conditions: [], minDwell: 0, hasExitTime: false, exitTime: 1,
        condition: { op: 'and', children: [{ param: 'Died', op: 'trigger' }] },
      },
    ],
    // The swing's contact frame, as a marker ON THE CLIP rather than a delay in the script.
    //
    // `Zombie Attack` runs 4.63 s: wind-up to 1.0 s, strike through 1.75 s, recovery to ~2.7 s. 1.25 s is
    // mid-strike. Two numbers constrain it and both are on the `Attack` state above — it cuts at
    // `exitTime: 0.58` (2.68 clip-seconds), so a later marker would never be reached and the zombie would
    // silently stop dealing damage; and it plays at `speed: 1.5`, so this lands ~0.83 s after the swing
    // starts. Marker times are CLIP seconds, never wall-clock.
    //
    // The point of attaching it to the clip: re-import a longer swing and the hit moves with it. The
    // constant it replaces could only drift.
    events: [{ clipName: 'Zombie Attack', time: 1.25, eventName: 'hit' }],
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
  // The placed instance carries its own inline copy of the subtree, so this is the THIRD place the
  // mannequin's clips lived. All three had to go, or the ones left behind come back as `Idle (2)`.
  stripEmbeddedClips(playable)
  withPlayerAnimation(playable)
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
    // Empty hashes either way, so this only decides whether the editor treats them as comparable at all
    // rather than as written by a build that hashed differently. Read from assetHash.ts, not copied.
    assetHashVersion: ASSET_HASH_VERSION,
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

  const libraries = {
    models,
    materials: sourceMaterials.filter(m => m.name !== 'torch blinn_phong'),
    terrainMaterials: sourceTerrainMats,
    // Re-pointed from the model it used to name to the RIG that owns the clips it blends. Both keys
    // together would leave two answers to "what does this field blend", so `modelId` is dropped —
    // `moveClipsToRigs` does exactly this to an existing project.
    animationFields: [playableField, zombieGait],
    animations,
    rigs,
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
        refs: sceneRefs({
          materialIds: libraries.materials.map(m => m.id),
          modelIds: [MANNEQUIN_MODEL],
          templateIds: libraries.templates.map(t => t.id),
          terrainMaterialIds: sourceTerrainMats.map(m => m.id),
          tilesetIds: tilesets.map(t => t.id),
          textureIds: textures.included,
          scriptIds: libraries.scripts.map(s => s.id),
          animationFieldIds: libraries.animationFields.map(f => f.id),
          // Two hops, which is why `buildSceneRefs` collects them at all: the scene places a MODEL, the
          // model names a RIG, and the rig owns the clips. Only the mannequin is placed directly — the
          // zombie arrives through its template, which the graph reaches via `templateIds`.
          animationIds: mannequinRig.animationIds,
        }),
      },
      {
        id: MENU_SCENE, name: 'Main Menu', updatedAt: CREATED_AT, dimension: '3D',
        refs: sceneRefs({}),
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

/**
 * A scene's own reference list, in the shape `buildSceneRefs` writes.
 *
 * Every key is spelled out and defaulted to empty, and `version` is stamped from the editor's own
 * constant. Both matter: `hasFullRefs` compares that version, and a scene whose stored refs predate it
 * is marked PARTIAL in the reference viewer — which is what the shipped example did, because it wrote
 * six of the fourteen keys and no version at all.
 */
function sceneRefs(refs) {
  return {
    version: SCENE_REFS_VERSION,
    materialIds: [], modelIds: [], templateIds: [], terrainMaterialIds: [], tilesetIds: [],
    aiBrainIds: [], textureIds: [], scriptIds: [], animationFieldIds: [], foliageModelIds: [],
    soundSampleIds: [], audioSourceIds: [], animationIds: [],
    ...refs,
  }
}

function vfs(libraries) {
  const entries = []
  // Virtual extensions come from the editor's own `KIND_EXT`, never from the kind name. They are what
  // `kindOfExt` classifies an entry by, so the `.material`/`.template`/`.animationField` this used to
  // write were unreadable to the asset explorer — a mistake nothing reported.
  const add = (folder, kind, items) => {
    const ext = KIND_EXT[kind]
    if (!ext) throw new Error(`no virtual extension for kind "${kind}"`)
    for (const item of items)
      entries.push({ path: `${folder}${item.name}${ext}`, kind, assetId: item.id, created: CREATED_AT })
  }
  add('/', 'scene', [{ name: 'Night Shift', id: NIGHT_SCENE }, { name: 'Main Menu', id: MENU_SCENE }])
  add('/Scripts/', 'script', libraries.scripts)
  add('/Templates/', 'template', libraries.templates)
  add('/Models/', 'model', libraries.models)
  add('/Materials/', 'material', libraries.materials)
  add('/Materials/', 'terrainMaterial', libraries.terrainMaterials)
  add('/Sprites/', 'tileset', libraries.tilesets)
  add('/Animation/', 'animationField', libraries.animationFields)
  add('/Animation/', 'animation', libraries.animations)
  // Beside the clips they own, not under /Models: a rig is a skeleton shared BY models, and both
  // characters' clip sets are reached through it.
  add('/Animation/', 'rig', libraries.rigs)

  const paths = entries.map(e => e.path)
  const clash = paths.find((p, i) => paths.indexOf(p) !== i)
  // A path is also the SVAR file-manager id, so a duplicate is not a cosmetic problem — two rows
  // collapse into one and one of the assets becomes unreachable in the explorer.
  if (clash) throw new Error(`two assets both want the vfs path "${clash}"`)

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
const zombieMaterialCount = (z) => (zombieModelNode(z).model.materials ?? [1]).length

function report({ zombie, libraries, textureCount }) {
  const size = (file) => fs.statSync(path.join(OUT, file)).size
  const total = walkSize(OUT)

  console.log('Night Shift written to editor/public/examples/night-shift/')
  console.log('')
  console.log('  scenes      Night Shift  %s', mb(size(`scenes/${NIGHT_SCENE}.json`)))
  console.log('              Main Menu    %s', mb(size(`scenes/${MENU_SCENE}.json`)))
  console.log('  libraries   models       %s  (%s)',
    mb(size('libraries/models.json')), libraries.models.map(m => m.name).join(' + '))
  console.log('              templates    %s  (Playable + Zombie)', mb(size('libraries/templates.json')))
  console.log('              animations   %s  %d clips', mb(size('libraries/animations.json')),
    libraries.animations.length)
  console.log('              rigs         %s  %d', mb(size('libraries/rigs.json')), libraries.rigs.length)
  console.log('              scripts      %d assets', libraries.scripts.length)
  console.log('              tilesets     %d', libraries.tilesets.length)
  console.log('  textures    %d payloads   %s', textureCount, mb(textures.bytes))
  console.log('')
  for (const rig of libraries.rigs) {
    console.log('  rig "%s": %d bones, %d clips, worn by %s', rig.name, rig.skin.joints.length,
      rig.animationIds.length,
      libraries.models.filter(m => m.rigId === rig.id).map(m => m.name).join(', ') || 'nothing')
  }
  console.log('  the Zombie is its own model asset now: %d material tiles', zombieMaterialCount(zombie))
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
