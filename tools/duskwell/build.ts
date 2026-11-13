// Duskwell: a small 2D metroidvania example, generated from the art in build/platformer.
//
//   npx vite-node --config vitest.config.ts tools/duskwell/build.ts
//
// Writes applications/editor/public/examples/duskwell/ (bundle format 2) and refreshes the gallery index.
//
// Everything is built with the engine's own classes (Scene, TilemapNode, AnimatedSpriteNode, Camera2DNode...)
// and serialized the way the editor saves a scene, so the project is exactly what the editor would write:
// nothing here hand-rolls a node format. What the generator adds is what a person would do in the editor --
// slice the sheets, pack the characters into atlases, paint the map, place the rooms and the cast, attach
// the scripts.
//
// Re-runnable: ids are stable (derived from names) and the art is read fresh, so the output is the same
// bytes every run.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
    Scene, Node, Tilemap, TilemapNode, Tileset, Sprite, SpriteNode, AnimatedSpriteNode, CharacterBody2DNode,
    Area2DNode, Room2DNode, Camera2DNode, ParallaxLayerNode, UIRootNode, UITextNode, RENDER_2D_DEFAULTS,
    ControllerNode, NavMeshNode, World2D, bakeNavGraph2D, navGraph2DSourceHash, parseBehaviorMachine, steeringTuning,
} from '../../src/cleo'
import type { NavAgent2D } from '../../src/cleo'
import type { SpriteAnimationSet, SpriteClip, SpriteFrameHitbox, SpriteStateMachine } from '../../src/cleo'
import { fromRuntimeTileset } from '../../applications/editor/src/utils/tilesets'
import type { TilesetAsset } from '../../applications/editor/src/utils/tilesets'
import { parseScriptVariables } from '../../applications/editor/src/utils/scripts'
import { assetHashKey, hashAsset, ASSET_HASH_VERSION } from '../../applications/editor/src/utils/assetHash'
import { KIND_EXT } from '../../applications/editor/src/utils/vfs'
import { SCENE_REFS_VERSION } from '../../applications/editor/src/utils/references'
import { TextureSet, stableId, writeJson, vars } from '../exampleKit/bundle.mjs'
import { packFormat2 } from '../exampleKit/packFormat2.mjs'
import { blankImage, blit, decodePng, encodePng } from '../exampleKit/png.mjs'
import { COLS, ROWS, ROOMS, cellCentre, cellFeet, isRock, markers, roomBounds, GRID, GUARD_ROUTE, GUARD_ROUTE_NAME } from './level'
import { BAT_BRAIN, GUARD_BRAIN } from './brains'
import { DUSK_INPUT_MAP } from './inputMap'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const ART = path.join(ROOT, 'build', 'platformer')
const OUT = path.join(ROOT, 'applications', 'editor', 'public', 'examples', 'duskwell')
const SCRIPTS = path.join(ROOT, 'examples', 'scripts')
/** The Pixel Platformer set: the ruins' tiles, the props, and the knight the Ruin Guard is drawn from. */
const PP_ROOT = 'PixelPlatformerSet1v.1.1/'
const PROJECT = 'Duskwell'
const CREATED_AT = 1795000000000
const PPU = 16
const id = (key: string) => stableId('duskwell:' + key)
const SCENE_ID = id('scene')

/** Nearest-filtered, unmipped, clamped: pixel art. Repeat for a backdrop that tiles. */
const PIXEL = { minFilter: 'nearest', magFilter: 'nearest', mipMapFilter: 'nearest', mipMap: false, wrapping: 'clamp' }
const PIXEL_REPEAT = { ...PIXEL, wrapping: 'repeat' }

const textures = new TextureSet(null)
/** Where each texture is filed in the Assets panel. */
const textureFolders: { id: string, folder: string, name: string }[] = []

// =====================================================================================================
// Atlases
// =====================================================================================================

interface Strip { name: string, file: string, frame: number, count?: number }

/**
 * Pack strips of square frames into one atlas, a grid of `cell`-pixel cells `columns` wide, in order. Returns
 * the tileset and, per strip, the tile indices of its frames.
 */
function packStrips(key: string, displayName: string, folder: string, strips: Strip[], cell: number, columns: number,
                    extra: Partial<ConstructorParameters<typeof Tileset>[0]> = {}): { tileset: Tileset, tiles: Record<string, number[]> } {
    const frames: { strip: string, img: ReturnType<typeof decodePng>, x: number }[] = []
    for (const s of strips) {
        const img = decodePng(path.join(ART, s.file))
        const n = s.count ?? Math.floor(img.width / s.frame)
        for (let i = 0; i < n; i++) frames.push({ strip: s.name, img, x: i * s.frame })
    }
    const rows = Math.ceil(frames.length / columns)
    const atlas = blankImage(columns * cell, rows * cell)
    const tiles: Record<string, number[]> = {}
    frames.forEach((f, i) => {
        const frame = strips.find(s => s.name === f.strip)!.frame
        blit(atlas, f.img, f.x, 0, frame, frame, (i % columns) * cell + (cell - frame) / 2, Math.floor(i / columns) * cell + (cell - frame))
        ;(tiles[f.strip] ??= []).push(i)
    })
    const textureId = `${key}.png`
    textures.addBytes(textureId, encodePng(atlas.width, atlas.height, atlas.data), PIXEL)
    textureFolders.push({ id: textureId, folder, name: displayName })
    const tileset = new Tileset({
        id: id('tileset:' + key), textureId, imageWidth: atlas.width, imageHeight: atlas.height,
        tileWidth: cell, tileHeight: cell, columns, rows, pixelsPerUnit: PPU, ...extra,
    })
    return { tileset, tiles }
}

/** Pack separate frame files (frame-01.png, frame-02.png...) into a one-row atlas. */
function packFrames(key: string, displayName: string, folder: string, files: string[], extra: Partial<ConstructorParameters<typeof Tileset>[0]> = {}): Tileset {
    const imgs = files.map(f => decodePng(path.join(ART, f)))
    const w = imgs[0].width, h = imgs[0].height
    const atlas = blankImage(w * imgs.length, h)
    imgs.forEach((img, i) => blit(atlas, img, 0, 0, w, h, i * w, 0))
    const textureId = `${key}.png`
    textures.addBytes(textureId, encodePng(atlas.width, atlas.height, atlas.data), PIXEL)
    textureFolders.push({ id: textureId, folder, name: displayName })
    return new Tileset({
        id: id('tileset:' + key), textureId, imageWidth: atlas.width, imageHeight: atlas.height,
        tileWidth: w, tileHeight: h, columns: imgs.length, rows: 1, pixelsPerUnit: PPU, ...extra,
    })
}

// --- the warrior -------------------------------------------------------------------------------------

const MW = 'Medieval Warrior Pack 3/Medieval Warrior Pack 3/Sprites/'
const warrior = packStrips('warrior', 'Warrior', '/Characters/Warrior/Textures', [
    { name: 'idle', file: MW + 'Idle.png', frame: 135 },
    { name: 'run', file: MW + 'Run.png', frame: 135 },
    { name: 'jump', file: MW + 'Jump.png', frame: 135 },
    { name: 'fall', file: MW + 'Fall.png', frame: 135 },
    { name: 'attack1', file: MW + 'Attack1.png', frame: 135 },
    { name: 'attack2', file: MW + 'Attack2.png', frame: 135 },
    { name: 'attack3', file: MW + 'Attack3.png', frame: 135 },
    { name: 'hurt', file: MW + 'Get Hit.png', frame: 135 },
    { name: 'death', file: MW + 'Death.png', frame: 135 },
], 135, 7)

/** The warrior's feet: 49 of the frame's 135 pixels above its bottom edge, at its middle. */
const WARRIOR_PIVOT: [number, number] = [0.49, 49 / 135]

function clipOf(name: string, tiles: number[], fps: number, loop: SpriteClip['loop'], extra: Partial<SpriteClip> = {},
                frameExtra: Record<number, Partial<SpriteClip['frames'][number]>> = {}): SpriteClip {
    return { name, fps, loop, frames: tiles.map((tile, i) => ({ tile, ...(frameExtra[i] ?? {}) })), ...extra }
}
const sword = (rect: [number, number, number, number]): SpriteFrameHitbox[] => [{ area: 'Sword', rect }]

const warriorMachine: SpriteStateMachine = {
    entry: 'idle',
    states: ['idle', 'run', 'jump', 'fall', 'attack1', 'attack2', 'attack3', 'hurt', 'death'].map(name => ({ name, clip: name })),
    transitions: [
        { from: 'idle', to: 'run', condition: { op: 'and', children: [{ param: 'grounded', op: 'true' }, { param: 'speedX', op: 'gt', value: 0.6, hysteresis: 0.4 }] } },
        { from: 'run', to: 'idle', condition: { param: 'speedX', op: 'lt', value: 0.6, hysteresis: 0.4 } },
        ...['idle', 'run'].map(from => ({ from, to: 'jump', condition: { op: 'and' as const, children: [{ param: 'grounded', op: 'false' as const }, { param: 'velocityY', op: 'gt' as const, value: 0 }] } })),
        ...['idle', 'run', 'jump'].map(from => ({ from, to: 'fall', condition: { op: 'and' as const, children: [{ param: 'grounded', op: 'false' as const }, { param: 'velocityY', op: 'lt' as const, value: -0.5 }] } })),
        { from: 'jump', to: 'idle', condition: { param: 'landed', op: 'trigger' } },
        { from: 'fall', to: 'idle', condition: { param: 'grounded', op: 'true' } },
        ...['attack1', 'attack2', 'attack3', 'hurt'].map(from => ({ from, to: 'idle', exitTime: 1 })),
    ],
}

const warriorSet: SpriteAnimationSet = {
    id: id('sprites:warrior'), name: 'Warrior', defaultClip: 'idle', machine: warriorMachine,
    clips: [
        clipOf('idle', warrior.tiles.idle, 10, 'loop'),
        clipOf('run', warrior.tiles.run, 12, 'loop', {}, { 2: { events: ['step'] }, 5: { events: ['step'] } }),
        clipOf('jump', warrior.tiles.jump, 8, 'once'),
        clipOf('fall', warrior.tiles.fall, 8, 'loop'),
        clipOf('attack1', warrior.tiles.attack1, 14, 'once', {}, { 2: { events: ['swing'], hitboxes: sword([1.6, 1.3, 2.8, 2]) } }),
        clipOf('attack2', warrior.tiles.attack2, 14, 'once', {}, { 2: { events: ['swing'], hitboxes: sword([1.6, 1.3, 2.8, 2]) } }),
        clipOf('attack3', warrior.tiles.attack3, 12, 'once', {}, { 3: { events: ['swing'], hitboxes: sword([1.9, 1.9, 3.6, 3.4]) } }),
        clipOf('hurt', warrior.tiles.hurt, 12, 'once'),
        clipOf('death', warrior.tiles.death, 10, 'once'),
    ],
}

// --- the bat -----------------------------------------------------------------------------------------

const BAT = 'DarkFantasyEnemies_FREE/DarkFantasyEnemies_FREE/Bat/Bat without VFX/'
const bat = packStrips('bat', 'Bat', '/Characters/Bat/Textures', [
    { name: 'sleep', file: BAT + 'Bat-Sleep.png', frame: 64 },
    { name: 'wakeup', file: BAT + 'Bat-WakeUp.png', frame: 64 },
    { name: 'fly', file: BAT + 'Bat-IdleFly.png', frame: 64 },
    { name: 'attack', file: BAT + 'Bat-Attack1.png', frame: 64 },
    { name: 'hurt', file: BAT + 'Bat-Hurt.png', frame: 64 },
    { name: 'die', file: BAT + 'Bat-Die.png', frame: 64 },
], 64, 8)

const batSet: SpriteAnimationSet = {
    id: id('sprites:bat'), name: 'Bat', defaultClip: 'sleep',
    clips: [
        clipOf('sleep', bat.tiles.sleep, 4, 'pingpong'),
        clipOf('wakeup', bat.tiles.wakeup, 16, 'once'),
        clipOf('fly', bat.tiles.fly, 12, 'loop'),
        clipOf('attack', bat.tiles.attack, 14, 'once', { next: 'fly' }),
        clipOf('hurt', bat.tiles.hurt, 14, 'once', { next: 'fly' }),
        clipOf('die', bat.tiles.die, 12, 'once'),
    ],
}

// --- the Ruin Guard (the Pixel Platformer knight) ------------------------------------------------------

const KNIGHT = PP_ROOT + 'Character/Sprite/'
const KNIGHT_CLIPS: [string, string[]][] = [
    ['idle', [1, 2, 3, 4, 5, 6].map(i => `idle-0${i}.png`)],
    ['run', [1, 2, 3, 4, 5, 6, 7].map(i => `run-0${i}.png`)],
    ['jump', ['jump-01.png']],
    ['fall', ['jump-02.png']],
    ['land', [1, 2, 3].map(i => `jump-landing-0${i}.png`)],
    ['attack', ['attack-01.png', 'attack-02.png', 'attack-03.png', 'attack-04.png', 'attack-05.png', 'attack-06.png', 'attack-07-continue.png', 'attack-08-continue.png']],
    ['dead', [1, 2, 3, 4].map(i => `dead-0${i}.png`)],
]
const knightTiles = packFrames('knight', 'Ruin Guard', '/Characters/Ruin Guard/Textures', KNIGHT_CLIPS.flatMap(([, files]) => files.map(f => KNIGHT + f)))
const knightIndex: Record<string, number[]> = {}
{
    let i = 0
    for (const [name, files] of KNIGHT_CLIPS) knightIndex[name] = files.map(() => i++)
}
/** The knight's feet: the frame's bottom edge, under its body (x 6..17 of 32). */
const KNIGHT_PIVOT: [number, number] = [11.75 / 32, 0.5 / 32]
const blade = (rect: [number, number, number, number]): SpriteFrameHitbox[] => [{ area: 'Blade', rect }]
const knightMachine: SpriteStateMachine = {
    entry: 'idle',
    states: ['idle', 'run', 'jump', 'fall', 'land', 'attack', 'dead'].map(name => ({ name, clip: name })),
    transitions: [
        { from: 'idle', to: 'run', condition: { op: 'and', children: [{ param: 'grounded', op: 'true' }, { param: 'speedX', op: 'gt', value: 0.5, hysteresis: 0.3 }] } },
        { from: 'run', to: 'idle', condition: { param: 'speedX', op: 'lt', value: 0.5, hysteresis: 0.3 } },
        ...['idle', 'run', 'land'].map(from => ({ from, to: 'jump', condition: { op: 'and' as const, children: [{ param: 'grounded', op: 'false' as const }, { param: 'velocityY', op: 'gt' as const, value: 0 }] } })),
        ...['idle', 'run', 'jump', 'land'].map(from => ({ from, to: 'fall', condition: { op: 'and' as const, children: [{ param: 'grounded', op: 'false' as const }, { param: 'velocityY', op: 'lt' as const, value: -0.5 }] } })),
        { from: 'jump', to: 'land', condition: { param: 'landed', op: 'trigger' } },
        { from: 'fall', to: 'land', condition: { param: 'grounded', op: 'true' } },
        { from: 'land', to: 'idle', exitTime: 1 },
        { from: 'attack', to: 'idle', exitTime: 1 },
    ],
}
const knightSet: SpriteAnimationSet = {
    id: id('sprites:knight'), name: 'Ruin Guard', defaultClip: 'idle', machine: knightMachine,
    clips: [
        clipOf('idle', knightIndex.idle, 8, 'loop'),
        clipOf('run', knightIndex.run, 12, 'loop'),
        clipOf('jump', knightIndex.jump, 8, 'once'),
        clipOf('fall', knightIndex.fall, 8, 'loop'),
        clipOf('land', knightIndex.land, 16, 'once'),
        // The blade is out on frames 3 and 4: the swing's arc ahead of the knight.
        clipOf('attack', knightIndex.attack, 12, 'once', {}, {
            2: { events: ['swing'], hitboxes: blade([0.95, 0.9, 1.4, 1.2]) },
            3: { hitboxes: blade([0.95, 0.9, 1.4, 1.2]) },
        }),
        clipOf('dead', knightIndex.dead, 8, 'once'),
    ],
}

// --- props -------------------------------------------------------------------------------------------

const PP = PP_ROOT
const torchTiles = packFrames('torch', 'Torch', '/Props/Torch/Textures', [1, 2, 3, 4].map(i => `${PP}Anim/torch-A-0${i}.png`), { overdrive: 2.6 })
const lampTiles = packFrames('lamp', 'Lamp', '/Props/Checkpoint/Textures', [1, 2, 3, 4].map(i => `${PP}Anim/light-0${i}.png`), { overdrive: 2 })
const diamondTiles = packFrames('diamond', 'Diamond', '/Props/Diamond/Textures', [1, 2, 3, 4, 5].map(i => `${PP}Anim/diamond-0${i}.png`), { overdrive: 1.6 })

// --- the level's tiles and the backdrop --------------------------------------------------------------

const TILE_COLS = 128
textures.add('main_lev_build.png', path.join(ART, PP + 'main_lev_build.png'), PIXEL)
textureFolders.push({ id: 'main_lev_build.png', folder: '/Level/Textures', name: 'Ruins Tiles' })
const T = (c: number, r: number) => r * TILE_COLS + c
const FLOOR = Array.from({ length: 13 }, (_, i) => T(14 + i, 20))
const UNDER = Array.from({ length: 13 }, (_, i) => T(14 + i, 21))
const FILL = [T(2, 9), T(3, 9), T(2, 10), T(3, 10)]
const WALL_EAST = [13, 14, 15, 16, 17].map(r => T(10, r))
const WALL_WEST = [12, 13, 14, 15, 16, 17].map(r => T(31, r))
const CEILING = Array.from({ length: 10 }, (_, i) => T(14 + i, 4))
const CAP_LEFT = T(12, 20), CAP_RIGHT = T(29, 20), CAP_LEFT_UNDER = T(12, 21), CAP_RIGHT_UNDER = T(29, 21)
const PLANK = Array.from({ length: 9 }, (_, i) => T(13 + i, 17))
const PLANK_LEFT = T(12, 17), PLANK_RIGHT = T(22, 17)
const ROCK_TILES = [...FLOOR, ...UNDER, ...FILL, ...WALL_EAST, ...WALL_WEST, ...CEILING, CAP_LEFT, CAP_RIGHT, CAP_LEFT_UNDER, CAP_RIGHT_UNDER]

const ruins = new Tileset({
    id: id('tileset:ruins'), textureId: 'main_lev_build.png', imageWidth: 2048, imageHeight: 1280,
    tileWidth: 16, tileHeight: 16, columns: TILE_COLS, rows: 80, pixelsPerUnit: PPU,
})
for (const t of ROCK_TILES) ruins.setMeta(t, { solid: true })
for (const t of [...PLANK, PLANK_LEFT, PLANK_RIGHT]) ruins.setMeta(t, { oneWay: true })

const BACKDROPS: { file: string, name: string, parallax: [number, number], order: number }[] = [
    { file: '01 background.png', name: 'Sky', parallax: [0, 0], order: -50 },
    { file: '02 background.png', name: 'Far Hills', parallax: [0.08, 0.3], order: -49 },
    { file: '03 background A.png', name: 'Mountains', parallax: [0.2, 0.5], order: -48 },
    { file: '04 background.png', name: 'Woods', parallax: [0.4, 0.7], order: -47 },
    { file: '05 background.png', name: 'Near Woods', parallax: [0.6, 0.85], order: -46 },
]
const backdropSets = BACKDROPS.map(b => {
    const textureId = `bg_${b.file.replace(/\W+/g, '_')}`
    textures.add(textureId, path.join(ART, PP + 'Background/' + b.file), PIXEL_REPEAT)
    textureFolders.push({ id: textureId, folder: '/Level/Backdrop/Textures', name: b.name })
    return new Tileset({
        id: id('tileset:bg:' + b.name), textureId, imageWidth: 426, imageHeight: 384, tileWidth: 426, tileHeight: 384,
        columns: 1, rows: 1, pixelsPerUnit: PPU,
    })
})

// =====================================================================================================
// The map
// =====================================================================================================

/** A cell's look picked from its neighbours: a top edge, a cap at a corner, a face, a ceiling, fill. */
function rockTile(c: number, r: number, pick: (list: number[]) => number): number {
    const n = isRock(c, r - 1), s = isRock(c, r + 1), w = isRock(c - 1, r), e = isRock(c + 1, r)
    if (!n) return !w ? CAP_LEFT : !e ? CAP_RIGHT : pick(FLOOR)
    if (!s) return pick(CEILING)
    const aboveIsTop = !isRock(c, r - 2)
    if (aboveIsTop && !isRock(c - 1, r - 1)) return CAP_LEFT_UNDER
    if (aboveIsTop && !isRock(c + 1, r - 1)) return CAP_RIGHT_UNDER
    if (!e) return pick(WALL_EAST)
    if (!w) return pick(WALL_WEST)
    if (aboveIsTop) return pick(UNDER)
    return pick(FILL)
}

/** A deterministic pick per cell, so re-runs paint the same map. */
const pickFor = (c: number, r: number) => (list: number[]) => list[Math.abs((c * 73856093) ^ (r * 19349663)) % list.length]

function buildMap(): TilemapNode {
    const map = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 })
    map.registerTileset(ruins)
    map.addLayer({ tilesetId: ruins.id, name: 'Ground' })
    map.entitySort = 'none'
    map.colliders3D = false
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const ch = GRID[r][c]
        if (ch === '#') map.setTile(0, c, r, rockTile(c, r, pickFor(c, r)))
        else if (ch === '=') {
            const left = GRID[r][c - 1] !== '=', right = GRID[r][c + 1] !== '='
            map.setTile(0, c, r, left ? PLANK_LEFT : right ? PLANK_RIGHT : pickFor(c, r)(PLANK))
        }
    }
    const node = new TilemapNode('Map', map, id('node:map'))
    node.setPosition([0, ROWS, 0])
    return node
}

// =====================================================================================================
// The cast
// =====================================================================================================

function animated(name: string, tileset: Tileset, set: SpriteAnimationSet | null, frames: number[] = [], opts: { fps?: number, pivot?: [number, number], sortingOrder?: number, randomStart?: boolean } = {}): AnimatedSpriteNode {
    const sprite = new Sprite({ tileset, pivot: opts.pivot, sortingOrder: opts.sortingOrder ?? 0 })
    const node = new AnimatedSpriteNode(name, sprite, { constraints: 'free', frames, fps: opts.fps ?? 10, randomStart: opts.randomStart })
    if (set) node.animationSet = set
    return node
}

/** Stable ids are given on the serialized tree (`stableIds`), by path; this only marks construction sites. */
const named = <T extends Node>(n: T): T => n

function buildPlayer(): CharacterBody2DNode {
    const [x, y] = cellFeet(...markers('P')[0])
    const player = named(new CharacterBody2DNode('Player'))
    player.setPosition([x, y, 0])
    player.size = [1, 2.2]
    player.layer = 1
    player.stepHeight = 0.45
    // The engine runs and jumps it (walk 8 u/s, a 3.4-unit jump); the dash, double jump and wall jump are
    // DuskPlayer's own (its 0.2 s dash, 4.4 units, clears the Long Hall's pit with a jump; a jump alone does not).
    const sprite = named(animated('Sprite', warrior.tileset, warriorSet, [], { pivot: WARRIOR_PIVOT, sortingOrder: 2 }))
    player.addChild(sprite)
    const blade = named(new Area2DNode('Sword', [2.8, 2]))
    blade.layer = 4
    blade.mask = 2
    blade.enabled = false
    player.addChild(blade)
    // Last child, as in the 3D examples: the driver that reads Move and Jump into the body's intent.
    player.addChild(playerController())
    return player
}

/** A controller reading the player's Move and Jump, world-relative (a 2D body has no camera basis). */
function playerController(): ControllerNode {
    const c = named(new ControllerNode('Player Controller'))
    c.controlSource = 'player'
    c.moveAction = 'Move'
    c.jumpAction = 'Jump'
    c.lookAction = ''
    c.sprintAction = ''
    c.crouchAction = ''
    c.aimSource = 'world'
    c.driveAimTarget = false
    return c
}

/** The 2D agent profile of a body, as its 2D navigation is baked for it. */
function agentOf(b: CharacterBody2DNode, maxDrop = 10): NavAgent2D {
    return {
        movement: b.movement, width: b.size[0], height: b.size[1], walkSpeed: b.walkSpeed, acceleration: b.acceleration,
        airControl: b.airControl, jumpHeight: b.jumpHeight, jumpTimeToApex: b.jumpTimeToApex,
        fallGravityMultiplier: b.fallGravityMultiplier, maxFallSpeed: b.maxFallSpeed, stepHeight: b.stepHeight,
        maxDrop, oneWayPlatforms: b.oneWayPlatforms,
    }
}

/** An AI controller running a library brain (its link and the embedded copy that runs), seeing layer 1. */
function aiController(name: string, brain: { id: string, machine: any }, o: Partial<ControllerNode>): ControllerNode {
    const c = named(new ControllerNode(name))
    c.controlSource = 'ai'
    c.aimSource = 'world'
    c.driveAimTarget = false
    c.brain = 'machine'
    c.targetKey = 'target'
    c.autoAcquire = true
    c.perceptionLayers = 1
    c.brainId = brain.id
    c.behavior = parseBehaviorMachine(brain.machine)
    Object.assign(c, o)
    return c
}

function buildGuard(i: number, c: number, r: number): CharacterBody2DNode {
    const [x, y] = cellFeet(c, r)
    const body = named(new CharacterBody2DNode(`Ruin Guard ${i + 1}`))
    body.setPosition([x, y, 0])
    body.size = [0.8, 1.8]
    body.layer = 2
    body.walkSpeed = 4.2
    body.runSpeed = 4.2
    body.jumpHeight = 3.6
    body.jumpTimeToApex = 0.4
    body.stepHeight = 0.45
    const sprite = named(animated('Sprite', knightTiles, knightSet, [], { pivot: KNIGHT_PIVOT, sortingOrder: 1 }))
    sprite.sprite.tint = [0.5, 0.45, 0.6]
    body.addChild(sprite)
    const edge = named(new Area2DNode('Blade', [1.4, 1.2]))
    edge.layer = 16
    edge.mask = 1
    edge.enabled = false
    body.addChild(edge)
    body.addChild(aiController('Guard Brain', GUARD_BRAIN, {
        perception: { fieldOfView: 120, range: 14, memorySpan: 6, reactionTime: 0.3 },
        eyeHeight: 1.5,
        routeName: GUARD_ROUTE_NAME,
        waypointRadius: 0.4,
        steering: steeringTuning({ maxSpeed: 4.2, arriveRadius: 0.4, slowRadius: 1, avoidDistance: 0.8 }),
    }))
    return body
}

function buildBat(i: number, c: number, r: number): CharacterBody2DNode {
    const [x, y] = cellCentre(c, r)
    const body = named(new CharacterBody2DNode(`Bat ${i + 1}`))
    body.setPosition([x, y - 0.5, 0])
    body.size = [1.2, 1]
    body.layer = 2
    body.movement = 'fly'
    body.flipSprites = false
    body.oneWayPlatforms = false
    body.walkSpeed = 3.2
    body.runSpeed = 3.2
    body.acceleration = 18
    body.addChild(named(animated('Sprite', bat.tileset, batSet, [], { pivot: [0.5, 0.35], sortingOrder: 1 })))
    const bite = named(new Area2DNode('Bite', [0.9, 0.8]))
    bite.offset = [0, 0.5]
    bite.layer = 16
    bite.mask = 1
    body.addChild(bite)
    body.addChild(aiController('Bat Brain', BAT_BRAIN, {
        perception: { fieldOfView: 360, range: 12, memorySpan: 4, reactionTime: 0.2 },
        eyeHeight: 0.5,
        waypointRadius: 0.5,
        steering: steeringTuning({ maxSpeed: 3.2, arriveRadius: 0.5, slowRadius: 1.5, avoidDistance: 0 }),
    }))
    return body
}

function buildTorch(i: number, c: number, r: number): AnimatedSpriteNode {
    const [x, y] = cellFeet(c, r)
    const torch = named(animated(`Torch ${i + 1}`, torchTiles, null, [0, 1, 2, 3], { fps: 8, pivot: [0.5, 0], randomStart: true, sortingOrder: -1 }))
    torch.setPosition([x, y, 0])
    return torch
}

function buildPickup(name: string, kind: string, c: number, r: number, tileset: Tileset, scale = 1, tint?: [number, number, number]): Area2DNode {
    const [x, y] = cellCentre(c, r)
    const area = named(new Area2DNode(name, [0.9, 0.9]))
    area.setPosition([x, y, 0])
    area.layer = 8
    area.mask = 1
    const gem = named(animated('Gem', tileset, null, [0, 1, 2, 3, 4].slice(0, tileset.tileCount), { fps: 10, randomStart: true }))
    gem.setScale([scale, scale, 1])
    if (tint) gem.sprite.tint = tint
    area.addChild(gem)
    ;(area as any).__pickup = kind
    return area
}

function buildCheckpoint(i: number, c: number, r: number): Area2DNode {
    const [x, y] = cellFeet(c, r)
    const area = named(new Area2DNode(`Checkpoint ${i + 1}`, [1.2, 3]))
    area.setPosition([x, y + 1.5, 0])
    area.layer = 8
    area.mask = 1
    const lamp = named(animated('Lamp', lampTiles, null, [0, 1, 2, 3], { fps: 8, pivot: [0.5, 0] }))
    lamp.setPosition([0, -1.5, 0])
    area.addChild(lamp)
    return area
}

function buildHud(): UIRootNode {
    const hud = named(new UIRootNode('HUD', 'screen'))
    const text = (name: string, anchor: [number, number], offsetMin: [number, number], offsetMax: [number, number], size: number, align: 'left' | 'center' | 'right') => {
        const t = named(new UITextNode(name))
        t.anchorMin = anchor; t.anchorMax = anchor
        t.offsetMin = offsetMin; t.offsetMax = offsetMax
        ;(t as any).fontSize = size
        ;(t as any).align = align
        t.text = ''
        hud.addChild(t)
        return t
    }
    // UI anchors run top-down: [0, 0] is the top-left corner, [0.5, 1] the bottom centre.
    text('Health', [0, 0], [40, 32], [560, 80], 34, 'left')
    text('Diamonds', [0, 0], [40, 82], [560, 126], 30, 'left')
    text('Notice', [0.5, 1], [-700, -150], [700, -90], 32, 'center')
    return hud
}

function buildScene(): Scene {
    const scene = new Scene()
    scene.dimension = '2D'
    const world = named(new Node('World'))
    scene.addNode(world)

    const backdrop = named(new Node('Backdrop'))
    world.addChild(backdrop)
    // Every image is opaque down to its bottom row, so a layer whose bottom edge shows leaves a strip of
    // the one behind it -- above a floor, or down a pit. Place each so its bottom sits at y = -1, under
    // the map's bottom edge, when the camera stands at its lowest, centred `LOW_VIEW` up: a layer's
    // centre is its origin plus the camera's height times (1 - parallax), so as the camera climbs a
    // nearer layer's bottom rises least and still covers the farther ones'. The sky (parallax 0) rides
    // centred on the view.
    const LOW_VIEW = 270 / PPU / 2
    const HALF_IMAGE = 384 / PPU / 2
    BACKDROPS.forEach((b, i) => {
        const layer = named(new ParallaxLayerNode(b.name, new Sprite({ tileset: backdropSets[i], sortingOrder: b.order })))
        layer.parallax = b.parallax
        layer.repeatX = true
        const y = b.parallax[1] === 0 ? 0 : -1 + HALF_IMAGE - LOW_VIEW * (1 - b.parallax[1])
        layer.setPosition([18, y, -10 + i])
        backdrop.addChild(layer)
    })

    world.addChild(buildMap())

    const rooms = named(new Node('Rooms'))
    world.addChild(rooms)
    for (const room of ROOMS) {
        const [x0, y0, x1, y1] = roomBounds(room)
        const node = named(new Room2DNode(room.name, [x1 - x0, y1 - y0]))
        node.zone = room.zone
        node.setPosition([(x0 + x1) / 2, (y0 + y1) / 2, 0])
        rooms.addChild(node)
    }

    const props = named(new Node('Torches'))
    world.addChild(props)
    markers('T').forEach(([c, r], i) => props.addChild(buildTorch(i, c, r)))

    const pickups = named(new Node('Pickups'))
    world.addChild(pickups)
    markers('D').forEach(([c, r], i) => pickups.addChild(buildPickup(`Diamond ${i + 1}`, 'diamond', c, r, diamondTiles, 1.4)))
    markers('A').forEach(([c, r]) => pickups.addChild(buildPickup('Dash Relic', 'dash', c, r, diamondTiles, 2.4, [1.9, 0.8, 1.5])))

    const checkpoints = named(new Node('Checkpoints'))
    world.addChild(checkpoints)
    markers('K').forEach(([c, r], i) => checkpoints.addChild(buildCheckpoint(i, c, r)))

    const enemies = named(new Node('Enemies'))
    world.addChild(enemies)
    markers('B').forEach(([c, r], i) => enemies.addChild(buildBat(i, c, r)))
    markers('G').forEach(([c, r], i) => enemies.addChild(buildGuard(i, c, r)))

    // The 2D navigation, baked for the enemies: a platform graph the guards chase on (walks, jumps, drops),
    // and an air grid for the bats. One box over the whole map; the routes the guards patrol ride on it.
    const navigation = named(new Node('Navigation'))
    world.addChild(navigation)
    const guardProfile = buildGuard(0, 0, 0)
    const batProfile = buildBat(0, 0, 0)
    for (const [name, profile] of [['Walker Nav', guardProfile], ['Flier Nav', batProfile]] as const) {
        const nav = named(new NavMeshNode(name))
        nav.space = '2D'
        nav.setPosition([COLS / 2, ROWS / 2, 0])
        nav.size = [COLS, ROWS, 1]
        nav.agent2D = agentOf(profile)
        if (profile === guardProfile) nav.routes = [{ name: GUARD_ROUTE_NAME, points: GUARD_ROUTE.map(([c, r]) => [...cellFeet(c, r), 0] as [number, number, number]), loop: true } as any]
        navigation.addChild(nav)
    }

    const player = buildPlayer()
    world.addChild(player)

    const camera = named(new Camera2DNode('Camera'))
    camera.followTarget = 'Player'
    camera.followOffset = [0, 1.6]
    camera.deadzone = [1.5, 1.2]
    camera.damping = 0.14
    camera.lookAhead = 1.5
    camera.active = true
    camera.setPosition([player.position[0], player.position[1] + 1.6, 10])
    world.addChild(camera)

    scene.addNode(buildHud())
    return scene
}

// =====================================================================================================
// Scripts
// =====================================================================================================

const SCRIPT_FILES: [string, string, string][] = [
    ['DuskPlayer', 'DuskPlayer.ts', 'characterBody2D'],
    ['DuskBat', 'DuskBat.ts', 'characterBody2D'],
    ['DuskGuard', 'DuskGuard.ts', 'characterBody2D'],
    ['DuskPickup', 'DuskPickup.ts', 'area2D'],
    ['DuskCheckpoint', 'DuskCheckpoint.ts', 'area2D'],
    ['DuskHud', 'DuskHud.ts', 'uiRoot'],
]
const scriptAssets = SCRIPT_FILES.map(([name, file, baseType]) => {
    const source = fs.readFileSync(path.join(SCRIPTS, file), 'utf8')
    return { id: id('script:' + name), name, baseType, source, kind: 'class', variables: parseScriptVariables(source) }
})
const scriptByName = new Map(scriptAssets.map(s => [s.name, s]))

/** Attach a script to a serialized node: the library link and the inline source, as the editor writes it. */
function withScript(json: any, name: string, scriptVars: Record<string, unknown> = {}) {
    const asset = scriptByName.get(name)
    if (!asset) throw new Error(`no script ${name}`)
    const known = new Set(asset.variables.map((v: any) => v.name))
    for (const key of Object.keys(scriptVars)) if (!known.has(key)) throw new Error(`${name} has no field "${key}"`)
    json.variables = { ...(json.variables ?? {}), ...vars({ __scriptId: asset.id }) }
    json.script = asset.source
    json.scriptVars = scriptVars
}

/**
 * Give every serialized node an id derived from its path of names (and its index among same-named
 * siblings), so a re-run writes the same ids. Node ids are referenced by nothing here but themselves.
 */
function stableIds(json: any, prefix = '') {
    const seen = new Map<string, number>()
    for (const c of json.children ?? []) {
        const k = seen.get(c.name) ?? 0
        seen.set(c.name, k + 1)
        const p = `${prefix}/${c.name}#${k}`
        c.id = id('node:' + p)
        stableIds(c, p)
    }
}

function walk(json: any, visit: (n: any) => void) {
    visit(json)
    for (const c of json.children ?? []) walk(c, visit)
}

// =====================================================================================================
// Write
// =====================================================================================================

async function main() {
    fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    fs.mkdirSync(path.join(OUT, 'libraries'), { recursive: true })
    fs.mkdirSync(path.join(OUT, 'scenes'), { recursive: true })

    const scene = buildScene()
    // Bake the 2D navigation from the map as built: what the editor's Bake does, headless.
    scene.root.updateTransforms(null)
    const world2D = new World2D()
    world2D.refresh(scene)
    for (const nav of scene.navMeshes) {
        if (nav.space !== '2D') continue
        const { data, stats } = bakeNavGraph2D(world2D.world, nav.bounds2D(), nav.agent2D)
        nav.setGraph2D(data, navGraph2DSourceHash(world2D.world, nav.bounds2D(), nav.agent2D))
        console.log(`${nav.name}: ${stats.nodes} nodes, ${JSON.stringify(stats.edges)}, ${stats.freeCells} free cells, ${stats.ms.toFixed(0)} ms`)
    }
    const serialized = await scene.serialize(true)
    const root = serialized.scene
    // The pickups' kinds, the scripts and their fields.
    const pickupKinds = new Map<string, string>()
    const collect = (n: Node) => { if ((n as any).__pickup) pickupKinds.set(n.id, (n as any).__pickup); n.children.forEach(collect) }
    collect(scene.root)
    walk(root, (n) => {
        if (n.name === 'Player' && n.type === 'characterBody2D') withScript(n, 'DuskPlayer')
        else if (n.type === 'characterBody2D' && /^Bat /.test(n.name)) withScript(n, 'DuskBat')
        else if (n.type === 'characterBody2D' && /^Ruin Guard /.test(n.name)) withScript(n, 'DuskGuard')
        else if (n.type === 'area2D' && /^Checkpoint /.test(n.name)) withScript(n, 'DuskCheckpoint')
        else if (n.type === 'area2D' && pickupKinds.has(n.id)) withScript(n, 'DuskPickup', { kind: pickupKinds.get(n.id), amount: 1 })
        else if (n.type === 'uiRoot' && n.name === 'HUD') withScript(n, 'DuskHud')
    })
    root.id = id('node:root')
    stableIds(root)
    // A controller drives the body it is a child of: its possession names the parent's (now stable) id.
    const possessParents = (n: any) => {
        for (const c of n.children ?? []) {
            if (c.type === 'controller') c.possessedId = n.id
            possessParents(c)
        }
    }
    possessParents(root)

    const tilesetAssets: TilesetAsset[] = [
        { ...fromRuntimeTileset(ruins, 'Ruins'), },
        fromRuntimeTileset(warrior.tileset, 'Warrior'),
        fromRuntimeTileset(bat.tileset, 'Bat'),
        fromRuntimeTileset(knightTiles, 'Ruin Guard'),
        fromRuntimeTileset(torchTiles, 'Torch'),
        fromRuntimeTileset(lampTiles, 'Lamp'),
        fromRuntimeTileset(diamondTiles, 'Diamond'),
        ...BACKDROPS.map((b, i) => fromRuntimeTileset(backdropSets[i], b.name)),
    ]

    const render = {
        ...RENDER_2D_DEFAULTS,
        clearColor: [0.03, 0.025, 0.04, 1],
        pipeline2D: 'flat',
        autoExposureEnabled: false,
        bloomIntensity: 0.6,
        vignetteStrength: 0.3,
        filmGrainIntensity: 0,
        chromaticAberrationStrength: 0,
        taaEnabled: false,
        motionBlurEnabled: false,
        ssaoEnabled: false,
        dofEnabled: false,
    }
    const libraries: Record<string, unknown[]> = {
        models: [], materials: [], terrainMaterials: [], animationFields: [], animControllers: [], boneMasks: [],
        animations: [], rigs: [], tilesets: tilesetAssets, scripts: scriptAssets, templates: [], particleSystems: [],
        aiBrains: [GUARD_BRAIN, BAT_BRAIN],
    }
    for (const [name, value] of Object.entries(libraries)) writeJson(path.join(OUT, 'libraries', `${name}.json`), value)
    writeJson(path.join(OUT, 'libraries', 'inputMap.json'), DUSK_INPUT_MAP)

    const hashes: Record<string, string> = {}
    for (const [kind, list] of [['tileset', tilesetAssets], ['script', scriptAssets], ['aiBrain', [GUARD_BRAIN, BAT_BRAIN]]] as const)
        for (const asset of list as any[]) hashes[assetHashKey(kind as any, asset.id)] = hashAsset(asset as any)
    writeJson(path.join(OUT, 'scenes', `${SCENE_ID}.json`), {
        scene: root, textures: [], ui: { version: 1, elements: [] },
        config: { graphics: { clearColor: render.clearColor }, render },
        assetHashes: hashes, assetHashVersion: ASSET_HASH_VERSION, savedAt: CREATED_AT,
    })
    const textureCount = textures.write(OUT)

    writeJson(path.join(OUT, 'manifest.json'), {
        formatVersion: 1, kind: 'project', createdAt: CREATED_AT, projectName: PROJECT,
        mainSceneId: SCENE_ID, openSceneId: SCENE_ID,
        sceneMetas: [{
            id: SCENE_ID, name: PROJECT, updatedAt: CREATED_AT, dimension: '2D',
            refs: {
                version: SCENE_REFS_VERSION,
                materialIds: [], modelIds: [], templateIds: [], terrainMaterialIds: [], aiBrainIds: [GUARD_BRAIN.id, BAT_BRAIN.id], animationFieldIds: [],
                foliageModelIds: [], soundSampleIds: [], audioSourceIds: [], animationIds: [], particleSystemIds: [],
                tilesetIds: tilesetAssets.map(t => t.id), textureIds: textures.included, scriptIds: scriptAssets.map(s => s.id),
            },
        }],
    })

    // The Assets panel: by what a thing is in the game.
    const entries: any[] = []
    const add = (folder: string, name: string, kind: string, assetId: string) =>
        entries.push({ path: `${folder}/${name}${(KIND_EXT as any)[kind]}`, kind, assetId, created: CREATED_AT })
    add('/Scenes', PROJECT, 'scene', SCENE_ID)
    const scriptFolder: Record<string, string> = {
        DuskPlayer: '/Characters/Warrior/Scripts', DuskBat: '/Characters/Bat/Scripts', DuskGuard: '/Characters/Ruin Guard/Scripts',
        DuskPickup: '/Props/Scripts',
        DuskCheckpoint: '/Props/Checkpoint/Scripts', DuskHud: '/UI/Scripts',
    }
    for (const s of scriptAssets) add(scriptFolder[s.name], s.name, 'script', s.id)
    add('/Characters/Ruin Guard', GUARD_BRAIN.name, 'aiBrain', GUARD_BRAIN.id)
    add('/Characters/Bat', BAT_BRAIN.name, 'aiBrain', BAT_BRAIN.id)
    const tilesetFolder: Record<string, string> = {
        Ruins: '/Level', Warrior: '/Characters/Warrior', Bat: '/Characters/Bat', 'Ruin Guard': '/Characters/Ruin Guard',
        Torch: '/Props/Torch', Lamp: '/Props/Checkpoint',
        Diamond: '/Props/Diamond',
    }
    for (const t of tilesetAssets) add(tilesetFolder[t.name] ?? '/Level/Backdrop', t.name, 'tileset', t.id)
    for (const t of textureFolders) {
        add(t.folder, t.name, 'texture', t.id)
        entries.push({ path: `${t.folder}/Source/${t.name}.png`, kind: 'image', assetId: t.id, created: CREATED_AT })
    }
    const dirs = new Set<string>()
    for (const e of entries) {
        const parts = e.path.split('/').filter(Boolean)
        for (let i = 1; i < parts.length; i++) dirs.add('/' + parts.slice(0, i).join('/'))
    }
    writeJson(path.join(OUT, 'vfs.json'), { version: 1, folders: [...dirs].sort(), entries })
    writeJson(path.join(OUT, 'example.json'), {
        name: PROJECT,
        description: 'A small 2D metroidvania on the flat 2D renderer: a warrior with a three-hit combo, bats that wake as you pass, two rooms the camera slides between, one-way platforms, checkpoints, diamonds, and the dash relic that carries you over the pit. Pixel-perfect at 480 x 270, with parallax backdrops and glowing torches.',
        order: 3,
    })

    const largest = await packFormat2(OUT)
    console.log(`Duskwell written: ${textureCount} textures, ${tilesetAssets.length} tilesets, ${scriptAssets.length} scripts; largest file ${(largest / 1048576).toFixed(1)} MB`)
}

await main()
