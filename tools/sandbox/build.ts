// The Sandbox example: a gray-box course and a Mixamo mannequin that moves the way Advanced Locomotion System v4
// does, built only from the engine's own tools: the Character and Controller nodes, Camera Rigs, a blend space,
// one animator, foot placement, and one input-only script. And a car to get into and drive: the vehicle simulation
// with the Car preset, as the Car template (its own Controller, camera rig and scripts). And a pistol and a rifle to
// carry, aim and fire (weapons/): a layer each that holds the weapon over the walk, an aim blend space each, and a
// gun script on each that shoots by raycast and pushes what it hits, with its effects as templates (weapons/fx.ts).
//
//   node --max-old-space-size=8192 tools/sandbox/prepare.mjs                      (the FBX files, once)
//   npx vite-node --config vitest.config.ts tools/sandbox/build.ts [--report]
//   npm --prefix applications/editor run examples:list
//
// Writes applications/editor/public/examples/sandbox/ (bundle format 2). `--report` prints what was measured off
// every clip and stops. Ids are derived from names, so a re-run writes the same bytes.

import fs from 'fs'
import path from 'path'
// Every feature installed: the car's Vehicle and Wheel nodes are the vehicles feature's, and parse into plain nodes
// (their fields lost) without it.
import '../../src/modules/all'
import { fileURLToPath } from 'url'
import { mat4, vec3 } from 'gl-matrix'
import { Geometry } from '../../src/core/geometry'
import { Node } from '../../src/core/scene/nodes/node'
import { parseNodeJson } from '../../src/core/scene/nodes/parseNodeJson'
import type { Animation, Skin } from '../../src/animation/animatedModel'
import { storeSkin, loadSkin } from '../../applications/editor/src/utils/animationAssets'
import { toRuntimeField } from '../../applications/editor/src/utils/animationFields'
import { resolvedPoseFor, type PoseAsset } from '../../applications/editor/src/utils/poseAssets'
import { parseScriptVariables } from '../../applications/editor/src/utils/scripts'
import { assetHashKey, hashAsset, ASSET_HASH_VERSION } from '../../applications/editor/src/utils/assetHash'
import { KIND_EXT } from '../../applications/editor/src/utils/vfs'
import { SCENE_REFS_VERSION } from '../../applications/editor/src/utils/references'
import { TextureSet, stableId, writeJson, vars } from '../exampleKit/bundle.mjs'
import { applyNodeFields } from '../exampleKit/nodeFields.mjs'
import { packFormat2 } from '../exampleKit/packFormat2.mjs'
import { templatizeScene, templatizeSubtree } from '../exampleKit/templatize'
import { mergeStaticColliders } from '../exampleKit/mergeColliders'
import { ALL_LAYERS, DEFAULT_LAYER_NAMES, LAYER } from '../../src/physics/collisionLayers'
import { encodePng, decodePng } from '../exampleKit/png.mjs'
import { convexShape, geometryJson } from '../valley/meshes.mjs'
import { makeClips, characterAcceleration, LEAN_BONES, LOOK_BONES, ROLES, type MadeClip } from './clips'
import { boneOf, bodyRoll, clipSeconds } from './measure'
import { aimField, locomotionField, lookField, machineTimings, poseField, stairPaces, stairsField, stateMachine, RUN_SPEED_GATE, STAIR_RATE, type PoseLink, type Speeds, type WeaponLayerSpec } from './machine'
import { aimVariantName, weaponPoses, WEAPON_NAMES, WEAPON_SOCKETS } from './weapons/layers'
import type { WeaponKind, WeaponModel } from './weapons/models'
import { FX_NAMES, FLASH_LIGHT, GLOW_EXPOSURE_WEIGHT, HOLE_DECAL, TRACER, bulletHolePng, particleSystems as shotParticleSystems } from './weapons/fx'
import { course, props, PROP_KINDS, SPAWN, TREAD, CAR, type Piece, type Prop } from './level'
import { CAR_FIT, readCar, seatPoints, rounded, type CarPart } from './car'
import { rotateByYaw, type YawPose } from '../../src/core/math'
import type { VehicleNode } from '../../src/core/scene/nodes/vehicleNode'
import { VolumetricCloudsNode } from '../../src/core/scene/nodes/volumetricCloudsNode'
import { WaterVolumeNode } from '../../src/core/scene/nodes/waterVolumeNode'
import { WaterMaterial } from '../../src/graphics/material'
import { WATER_LOOK_PRESETS } from '../../src/water/waterLook'
import { UIRootNode } from '../../src/core/scene/nodes/ui/uiRoot'
import { UIPanelNode } from '../../src/core/scene/nodes/ui/uiContainers'
import { UITextNode } from '../../src/core/scene/nodes/ui/uiContent'
import { sandboxInputMap } from './inputMap'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PREPARED = path.join(ROOT, 'build', 'sandbox_prepared')
// `--out <folder>`: write the bundle there instead (for building beside a dev server that watches the examples:
// this removes the folder it writes and rebuilds it, which can crash Vite's watcher; copy the files that changed).
const OUT_FLAG = process.argv.indexOf('--out')
const OUT = OUT_FLAG >= 0 && process.argv[OUT_FLAG + 1]
    ? path.resolve(process.argv[OUT_FLAG + 1])
    : path.join(ROOT, 'applications', 'editor', 'public', 'examples', 'sandbox')
const SCRIPTS = path.join(ROOT, 'examples', 'scripts')
const PROJECT = 'Sandbox'
const CREATED_AT = 1795100000000
const id = (key: string) => stableId('sandbox:' + key)
const SCENE_ID = id('scene')
const REPORT = process.argv.includes('--report')
const round = (v: number, f = 1e5) => Math.round(v * f) / f

/**
 * The collision layers (named in the project's settings, which ship with it). The engine's four, and three of the
 * course's own. Foot Detail is what the feet stand on and the capsule passes through: the stairs' steps and the
 * bumps (left out of the capsule's Collides with; props land on them and the camera stops at them). Stair Ramp is
 * the ramp laid over each flight, which only the Character layer collides with: what the capsule climbs. The
 * pillars are on the engine's See Through, which the camera sees through. Vehicle is the car's chassis.
 */
const LAYERS = {
    ...LAYER,
    CHARACTER: 1 << 4,
    FOOT_DETAIL: 1 << 5,
    STAIR_RAMP: 1 << 6,
    VEHICLE: 1 << 7,
}
const LAYER_NAMES = DEFAULT_LAYER_NAMES.map((n, i) => (i === 4 ? 'Character' : i === 5 ? 'Foot Detail' : i === 6 ? 'Stair Ramp' : i === 7 ? 'Vehicle' : n))
/** A piece's layer (level.ts), as bits. */
const PIECE_LAYER = { footDetail: LAYERS.FOOT_DETAIL, seeThrough: LAYERS.SEE_THROUGH } as const
/** What the player's capsule collides with: everything but the feet's detail, which it walks on through. */
const CHARACTER_MASK = ALL_LAYERS & ~LAYERS.FOOT_DETAIL
/** What the camera's boom stops at: what a rig is blocked by by default, but never the ramp (the steps are what show). */
const CAMERA_BLOCKED_BY = ALL_LAYERS & ~(LAYERS.SEE_THROUGH | LAYERS.NO_CAMERA | LAYERS.STAIR_RAMP)
/** What the feet land on: everything but the ramp. */
const FOOT_TRACE_LAYERS = ALL_LAYERS & ~LAYERS.STAIR_RAMP

/** Character tuning (section 4 of the plan): what is not measured is chosen here, in one place. */
const TUNING = {
    jumpSpeed: 3.0,
    gravity: 9.82,
    capsuleRadius: 0.28,
    mass: 75,
    /** The sprint, m/s: ALS's 6.5. The sprint clip covers 5.2, so it plays about a quarter faster to match. */
    sprint: 6.5,
}

// =====================================================================================================
// Inputs
// =====================================================================================================

if (!fs.existsSync(path.join(PREPARED, 'character.json')))
    throw new Error('build/sandbox_prepared is missing: run `node --max-old-space-size=8192 tools/sandbox/prepare.mjs` first')
const character = JSON.parse(fs.readFileSync(path.join(PREPARED, 'character.json'), 'utf8'))
const toMat = (a: number[]) => { const m = mat4.create(); for (let i = 0; i < 16; i++) m[i] = a[i]; return m }
const skin: Skin = loadSkin(storeSkin(character.skin), toMat)

const raw = new Map<string, Animation>()
for (const f of fs.readdirSync(path.join(PREPARED, 'clips'))) {
    const { clip } = JSON.parse(fs.readFileSync(path.join(PREPARED, 'clips', f), 'utf8'))
    raw.set(f.replace(/\.json$/, ''), clip)
}
/** Ankle height over the sole at rest: what the foot solver keeps between the ground and the ankle. */
const footHeight = (() => {
    const parents = skin.nodeParents as Map<number, number>
    const world = (i: number): mat4 => { const p = parents.get(i); const l = (skin.nodeTransforms as Map<number, mat4>).get(i)!; return p === undefined ? l : mat4.multiply(mat4.create(), world(p), l) }
    let bottom = Infinity
    for (const p of character.parts) for (let k = 1; k < p.positions.length; k += 3) bottom = Math.min(bottom, p.positions[k])
    return round(mat4.getTranslation(vec3.create(), world(boneOf(skin, 'LeftFoot')))[1] - bottom, 1e3)
})()

const warnings: string[] = []
const clips = makeClips(skin, raw, w => { warnings.push(w); console.warn('warning: ' + w) }, { sprint: TUNING.sprint, footHeight, carSeatHips: CAR_FIT.seatHips }, s => console.log(s))

const speeds: Speeds = {
    walk: clips.get('WalkF')!.m.speed,
    jog: clips.get('JogF')!.m.speed,
    sprint: TUNING.sprint,
    physicsAir: 2 * TUNING.jumpSpeed / TUNING.gravity,
    back: clips.get('JogB')!.m.speed / clips.get('JogF')!.m.speed,
    jogDiagonal: clips.get('JogBR')!.m.speed / clips.get('JogF')!.m.speed,
    walkDiagonal: 0,
    acceleration: 0,
}
// Walking, a back diagonal goes at the mean of the side and the back: the walk clips' own two speeds.
speeds.walkDiagonal = (1 + clips.get('WalkB')!.m.speed / clips.get('WalkF')!.m.speed) / 2

/** The ground-plane distance the Stop clip's hips cover, for the deceleration that matches it. */
const stopTravel = Math.hypot(...clips.get('Stop')!.m.travel)
const acceleration = characterAcceleration(clips)
speeds.acceleration = acceleration
// A sprint from a standstill takes off at the start clip's own acceleration (SandboxPlayer's sprintTakeoff).
speeds.takeoff = clips.get('Start')!.accel!

/**
 * The sideways lean each held-in-place clip has against its source, in the body's own frame: holding a clip in
 * place must not tilt it (the engine's bakeInPlace did, up to 51 degrees on the hard landing).
 */
function rollCheck(): string[] {
    const lines: string[] = []
    for (const [name, c] of clips) {
        // A mirror leans the other way by construction: its source is its unmirrored twin, checked already.
        if (!c.role || !['loop', 'oneShot', 'stop', 'air', 'start'].includes(c.role.kind) || name.endsWith('Mirror')) continue
        const source = raw.get(c.role.file)!
        const offset = name.endsWith('Air') ? c.takeoff! : (name.endsWith('Land') || name.startsWith('Land')) ? c.touchdown! : 0
        const T = clipSeconds(c.clip)
        const times = Array.from({ length: Math.max(2, Math.round(T * 30)) + 1 }, (_, k) => T * k / Math.max(2, Math.round(T * 30)))
        const a = bodyRoll(skin, c.clip, times), b = bodyRoll(skin, source, times.map(t => t + offset))
        // Both relative to their first sample: the conditioned clip starts where the source does.
        const worst = Math.max(...times.map((_, k) => Math.abs((a[k] - a[0]) - (b[k] - b[0]))))
        lines.push(`${name}: ${worst.toFixed(1)} deg`)
        if (worst > 3) throw new Error(`${name} leans ${worst.toFixed(1)} degrees sideways more than its source once held in place`)
    }
    return lines
}

function report() {
    console.log('clip            source s   speed m/s  dir    strikeL  strikeR  air spans (s)                 notes')
    for (const [name, c] of clips) {
        const air = c.m.air.map(a => `${a.from.toFixed(2)}-${a.to.toFixed(2)}@${a.peak.toFixed(2)}`).join(' ')
        const notes = [c.takeoff !== undefined ? `cut ${c.takeoff.toFixed(2)}-${c.touchdown!.toFixed(2)}` : '', c.turnDone !== undefined ? `turn done at ${(c.turnDone * 100).toFixed(0)}%` : '', c.clip.rootMotion ? 'root motion' : ''].filter(Boolean).join(', ')
        console.log(`${name.padEnd(15)} ${c.m.seconds.toFixed(3).padStart(8)}  ${c.m.speed.toFixed(2).padStart(9)}  ${c.m.direction.toFixed(0).padStart(5)}  ${String(c.m.strikeL?.toFixed(2) ?? '-').padStart(7)}  ${String(c.m.strikeR?.toFixed(2) ?? '-').padStart(7)}  ${air.padEnd(30)} ${notes}`)
    }
    const sprintClip = clips.get('SprintF')!.m.speed
    console.log(`speeds: walk ${speeds.walk.toFixed(2)}, jog ${speeds.jog.toFixed(2)}, sprint ${speeds.sprint.toFixed(2)} m/s (the clip covers ${sprintClip.toFixed(2)}: plays at ${(speeds.sprint / sprintClip).toFixed(2)}x); level jump air ${speeds.physicsAir.toFixed(2)} s; acceleration ${acceleration.toFixed(1)} m/s2 (stop travel ${stopTravel.toFixed(2)} m)`)
}
report()
const start = clips.get('Start')!
console.log(`start: fits ${start.accel!.toFixed(1)} m/s2, the sprint's take-off, played at ${start.rate!.toFixed(2)}x over ${clipSeconds(start.clip).toFixed(2)} s`)
console.log(`sideways lean against the source: ${rollCheck().join(', ')}`)
// When each foot may lock, as a share of each clip: from the ball coming down to the heel lifting.
console.log('foot-lock windows: ' + [...clips.values()].filter(c => c.clip.footLocks).map(c => {
    const T = clipSeconds(c.clip)
    const side = (k: string) => (c.clip.footLocks![k] ?? []).map(([a, b]) => `${(a / T).toFixed(2)}-${(b / T).toFixed(2)}`).join(' ') || 'none'
    return `${c.clip.name} L ${side('foot.L')} R ${side('foot.R')}`
}).join('; '))
const timing = machineTimings(clips, skin)
// The stairs: each clip's steps as read, and the pace a flight is climbed at (one tread a step, STAIR_RATE).
const paces = stairPaces(clips, TREAD)
console.log('stairs: ' + [...clips.values()].filter(c => c.stairs).map(c => `${c.clip.name} ${c.stairs!.stepsPerSecond.toFixed(2)} steps/s, riser ${(c.stairs!.rise * 100).toFixed(0)} cm, step ${(c.stairs!.step * 100).toFixed(0)} cm`).join('; ')
    + ` -> paces (horizontal, at ${STAIR_RATE}x) up ${paces.upWalk} / ${paces.upRun}, down ${paces.downWalk} / ${paces.downRun} m/s`)
console.log(`hand-overs (the field's phase 0 is a ${timing.phaseFoot === 'L' ? 'left' : 'right'} plant): start -> run at ${timing.startExit}; running turns at ${JSON.stringify(timing.runTurnExit)}; running landing at ${timing.landRunExit}; stops settle at ${JSON.stringify(timing.settle)}, ${timing.stopEarly} in the run's first half and ${timing.stopLate} in its second; landing impacts (s) ${JSON.stringify(timing.impact)}`)
// The weapons: their models, how the hands hold them, and the poses their layers hold (weapons/): each weapon's
// Carry, Aim and Sprint, and the aim's directions as variants of Aim.
const weaponBuild = weaponPoses(skin, new Map([...clips].map(([k, c]) => [k, c.clip])), 'Idle',
    new Map([...raw].filter(([k]) => k.startsWith('Rifle '))), ROOT)
for (const line of weaponBuild.report) console.log('weapons: ' + line)
if (REPORT) process.exit(0)

// Sanity: the numbers everything else is built from.
for (const [name, lo, hi] of [['WalkF', 1.2, 2], ['JogF', 3, 5], ['SprintF', 4.5, 9]] as const) {
    const s = clips.get(name)!.m.speed
    if (s < lo || s > hi) throw new Error(`${name} covers ${s.toFixed(2)} m/s, outside ${lo}..${hi}`)
}

// =====================================================================================================
// Textures and materials
// =====================================================================================================

const textures = new TextureSet(null)
const textureFolders: { id: string, folder: string, name: string }[] = []
const COLOR_MAP = { wrapping: 'repeat', mipMap: true, mipMapFilter: 'linear' }
const map = (name: string) => path.join(PREPARED, 'maps', `Ch36_1001_${name}.png`)
const TEX = {
    diffuse: textures.add(id('tex:diffuse'), map('Diffuse'), COLOR_MAP),
    normal: textures.add(id('tex:normal'), map('Normal'), COLOR_MAP),
    // glTF metal-roughness: G is roughness (1 - the FBX's glossiness), B metalness (none).
    mr: textures.addBytes(id('tex:mr'), (() => {
        const g = decodePng(fs.readFileSync(map('Glossiness')))
        const out = new Uint8Array(g.width * g.height * 4)
        for (let i = 0; i < g.width * g.height; i++) { out[i * 4] = 255; out[i * 4 + 1] = 255 - g.data[i * 4]; out[i * 4 + 2] = 0; out[i * 4 + 3] = 255 }
        return encodePng(g.width, g.height, out)
    })(), COLOR_MAP),
    // A metre grid for the course, projected in world space.
    grid: textures.addBytes(id('tex:grid'), (() => {
        const n = 256, out = new Uint8Array(n * n * 4)
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            const edge = x < 3 || y < 3 || x >= n - 3 || y >= n - 3
            const half = Math.abs(x - n / 2) < 1 || Math.abs(y - n / 2) < 1
            const v = edge ? 90 : half ? 150 : 205
            out.set([v, v, v, 255], (y * n + x) * 4)
        }
        return encodePng(n, n, out)
    })(), COLOR_MAP),
}
textureFolders.push(
    { id: TEX.diffuse, folder: '/Characters/Mannequin/Textures', name: 'Mannequin Base Color' },
    { id: TEX.normal, folder: '/Characters/Mannequin/Textures', name: 'Mannequin Normal' },
    { id: TEX.mr, folder: '/Characters/Mannequin/Textures', name: 'Mannequin Roughness' },
    { id: TEX.grid, folder: '/Level/Textures', name: 'Grid' },
)

const config = { side: 'front', wireframe: false, transparent: false, castShadow: true, probeable: true }
const pbr = (baseColor: number[], extra: any = {}) => ({
    type: 'pbr', baseColor, metallic: 0, roughness: 0.9, opacity: 1, emissiveFactor: [0, 0, 0], textures: {}, config, ...extra,
})
const GRID_UV = { uvProjection: 'box', uvSpace: 'world', uvWorldSize: 1 }
const PROP_UV = { uvProjection: 'box', uvSpace: 'object', uvWorldSize: 0.25 }
const materials = [
    { id: id('mat:mannequin'), name: 'Mannequin', material: pbr([1, 1, 1], { metallic: 1, roughness: 1, textures: { baseColorTexture: TEX.diffuse, metallicRoughnessTexture: TEX.mr, normalMap: TEX.normal } }), textureIds: [TEX.diffuse, TEX.mr, TEX.normal] },
    { id: id('mat:floor'), name: 'Floor Grid', material: pbr([0.55, 0.56, 0.58], { textures: { baseColorTexture: TEX.grid }, ...GRID_UV }), textureIds: [TEX.grid] },
    { id: id('mat:block'), name: 'Block Grid', material: pbr([0.85, 0.55, 0.32], { textures: { baseColorTexture: TEX.grid }, ...GRID_UV }), textureIds: [TEX.grid] },
    { id: id('mat:accent'), name: 'Accent Grid', material: pbr([0.42, 0.55, 0.75], { textures: { baseColorTexture: TEX.grid }, ...GRID_UV }), textureIds: [TEX.grid] },
    // The props move, so their grid is in the object's own space: a world-space grid swims over a moving body.
    { id: id('mat:prop'), name: 'Prop Grid', material: pbr([0.9, 0.62, 0.3], { textures: { baseColorTexture: TEX.grid }, ...PROP_UV }), textureIds: [TEX.grid] },
    { id: id('mat:propAccent'), name: 'Prop Accent Grid', material: pbr([0.35, 0.5, 0.85], { textures: { baseColorTexture: TEX.grid }, ...PROP_UV }), textureIds: [TEX.grid] },
]
// The car's, from its file: the body, the windows (blended: a fixed opacity, no shadow) and the wheels, each with the
// maps it carries (glTF metal-roughness: G roughness, B metalness).
const CAR_FILE = path.join(ROOT, 'build', 'car', 'dirty_car.glb')
const car = readCar(CAR_FILE)
const carImage = (texture: number | undefined) => {
    if (texture === undefined) return null
    const image = car.textures[texture]
    const tid = id('tex:car:' + image)
    return textures.addBytes(tid, car.images[image].bytes, COLOR_MAP, car.images[image].mime)
}
const CAR_PART_NAMES = ['Car Body', 'Car Glass', 'Car Wheels']
const carMaterials = car.materials.map((m: any, i: number) => {
    const p = m.pbrMetallicRoughness ?? {}
    const maps: Record<string, string> = {}
    const base = carImage(p.baseColorTexture?.index), mr = carImage(p.metallicRoughnessTexture?.index), normal = carImage(m.normalTexture?.index)
    if (base) maps.baseColorTexture = base
    if (mr) maps.metallicRoughnessTexture = mr
    if (normal) maps.normalMap = normal
    const blend = m.alphaMode === 'BLEND'
    const color = p.baseColorFactor ?? [1, 1, 1, 1]
    const name = CAR_PART_NAMES[i] ?? m.name
    for (const [slot, tid] of Object.entries(maps))
        if (!textureFolders.some(t => t.id === tid))
            textureFolders.push({ id: tid, folder: '/Vehicles/Car/Textures', name: `${name} ${slot === 'baseColorTexture' ? 'Base Color' : slot === 'normalMap' ? 'Normal' : 'Metal Roughness'}` })
    return {
        id: id('mat:car:' + i), name,
        material: pbr([color[0], color[1], color[2]], {
            metallic: p.metallicFactor ?? 1, roughness: p.roughnessFactor ?? 1, opacity: blend ? color[3] : 1, textures: maps,
            config: { side: m.doubleSided ? 'double' : 'front', wireframe: false, transparent: blend, castShadow: !blend, probeable: true },
        }),
        textureIds: [...new Set(Object.values(maps))],
    }
})
const carMaterialOf = (part: CarPart) => carMaterials[part.material]
const matById = (mid: string) => JSON.parse(JSON.stringify([...materials, ...carMaterials].find(m => m.id === mid)!.material))
const LEVEL_MAT = { floor: id('mat:floor'), block: id('mat:block'), accent: id('mat:accent') }
const PROP_MAT = { prop: id('mat:prop'), propAccent: id('mat:propAccent') }

// =====================================================================================================
// The skeleton, its clips, the blend space and the animator
// =====================================================================================================

const leg = (side: string) => ({ thigh: boneOf(skin, `${side}UpLeg`), shin: boneOf(skin, `${side}Leg`), foot: boneOf(skin, `${side}Foot`), toe: boneOf(skin, `${side}ToeBase`) })
const ikRig = {
    hips: boneOf(skin, 'Hips'), feet: [leg('Left'), leg('Right')],
    // ALS v4's traces: 50 cm above the foot, 45 below. On the steps of a flight of stairs, not on the ramp the
    // capsule climbs over them: the feet stand on the treads.
    footHeight, traceUp: 0.5, traceDown: 0.45, traceLayers: FOOT_TRACE_LAYERS, maxHipDrop: 0.35, maxSlopeDeg: 40,
    // A foot lifted more than 4 cm over the lower one is the clip's own heel-off or swing: left to the clip, or
    // the solver pulls the heel down mid-stride and the ball of the foot slides.
    swingRelease: 0.04, smoothing: 0.1,
    // ALS's foot locking: a planted foot holds its spot and heading while the body turns over it (the camera
    // swinging the body round as it walks), instead of riding round with it as if on ice. Eased in over 80 ms and
    // out over 200 on a smooth curve. Setting off, the cross-fade out of Idle slides the feet: one sliding faster
    // than 0.6 m/s is not caught then, or the lock stops it dead and stretches the leg after it (a snap).
    footLock: 1, lockBlendIn: 0.08, lockRelease: 0.2, lockBlendCurve: 'smooth', lockCatchSpeed: 0.6,
    // A planted foot may be left half a metre behind before it lets go: through a sharp change of direction the
    // blend space plays the old direction for a moment and moves its foot away from the lock that fast.
    lockDistance: 0.5,
}
const storedSkin = storeSkin({ ...skin, nodeTransforms: new Map([...(skin.nodeTransforms as Map<number, mat4>)].map(([k, v]) => [k, Array.from(v, x => round(x, 1e6))])) } as any)!
// The weapons' grips on the right hand (weapons/layers.ts): each socket's frame is its weapon's.
const skinJson = { ...storedSkin, ikRig, sockets: weaponBuild.sockets }

const RIG_ID = id('rig:mannequin')
const plainClip = (c: Animation) => ({
    name: c.name,
    samplers: c.samplers.map(s => ({ input: Array.from(s.input, v => round(v)), output: Array.from(s.output, v => round(v)), interpolation: s.interpolation ?? 'LINEAR' })),
    channels: c.channels.map(ch => ({ samplerIndex: ch.samplerIndex, targetNodeIndex: ch.targetNodeIndex, targetPath: ch.targetPath })),
    ...(c.rootMotion ? { rootMotion: true } : {}),
    ...(c.footLocks ? { footLocks: Object.fromEntries(Object.entries(c.footLocks).map(([k, spans]) => [k, spans.map(([a, b]) => [round(a, 1e4), round(b, 1e4)])])) } : {}),
})
const animations = [
    ...[...clips.values()].map((c: MadeClip) => ({
        id: id('anim:' + c.clip.name), name: c.clip.name, clips: [plainClip(c.clip)], rigId: RIG_ID, sourceSkin: storedSkin,
        ...(c.role ? { sourceFile: `${c.role.file}.fbx` } : {}),
    })),
]
const WEAPON_KINDS = ['pistol', 'rifle'] as const
const WEAPON_MODEL_ID: Record<WeaponKind, string> = { pistol: id('model:pistol'), rifle: id('model:rifle') }
const rig = {
    id: RIG_ID, name: 'Mannequin', skin: skinJson, ikRig, animationIds: animations.map(a => a.id),
    // Each weapon is shown on its socket in the animation editors.
    sockets: weaponBuild.sockets.map((sk, i) => ({ id: id('socket:' + sk.name), ...sk, previewModelId: WEAPON_MODEL_ID[WEAPON_KINDS[i]] })),
}

const FIELD_ID = id('field:locomotion')
const field = locomotionField(clips, speeds, timing.phaseFoot)
const fieldAsset = { id: FIELD_ID, name: 'Locomotion', rigId: RIG_ID, ...field, yAxis: field.yAxis! }
const runtimeField = toRuntimeField(fieldAsset as any)
const CONTROLLER_ID = id('controller:locomotion')
// What the lean layers move: the whole body tilts about the ground (the hips, the legs and feet, the spine and the
// head); the arms ride on.
const LEAN_MASK = {
    id: id('mask:lean'), name: 'Lean', rigId: RIG_ID,
    weights: Object.fromEntries(LEAN_BONES.map(b => [(skin.nodeNames as Map<number, string>).get(boneOf(skin, b))!, 1])),
}
// The look-at: the trunk and head, hips up.
const LOOK_MASK = {
    id: id('mask:look'), name: 'Look', rigId: RIG_ID,
    weights: Object.fromEntries(LOOK_BONES.map(b => [(skin.nodeNames as Map<number, string>).get(boneOf(skin, b))!, 1])),
}
const LOOK_FIELD_ID = id('field:look')
const look = lookField()
const lookFieldAsset = { id: LOOK_FIELD_ID, name: 'Look', rigId: RIG_ID, ...look, yAxis: look.yAxis! }
// The flights' blend space: up and down (a direction whose clips failed the check has none).
const stairs = stairsField(clips, timing.phaseFoot, TREAD)
const stairAssets = stairs ? (() => {
    const { up, down, ...field } = stairs
    return [{ up, down, asset: { id: id('field:stairs'), name: 'Stairs', rigId: RIG_ID, ...field, yAxis: field.yAxis! } }]
})() : []
// The weapons' POSES: one Pose asset each (`Rifle Poses`, `Pistol Poses`), edited in the editor's pose mode: Carry,
// Aim and Sprint, and the aim's directions as variants of Aim (each stores what it changes from Aim, so an edit to
// Aim moves them all). Everything below embeds them resolved, as the editor does.
const WEAPON_POSE_ASSET: Record<WeaponKind, string> = { pistol: id('pose:pistol'), rifle: id('pose:rifle') }
const poseLink = (kind: WeaponKind, key: string): PoseLink => ({ assetId: WEAPON_POSE_ASSET[kind], poseId: id(`pose:${kind}:${key}`) })
const aimKey = (yaw: number, pitch: number) => `aim:${yaw}:${pitch}`
const weaponPoseAssets: PoseAsset[] = WEAPON_KINDS.map(kind => {
    const set = weaponBuild.poses[kind]
    const aim = poseLink(kind, 'aim')
    return {
        id: WEAPON_POSE_ASSET[kind], name: `${WEAPON_NAMES[kind]} Poses`, rigId: RIG_ID,
        poses: [
            { id: poseLink(kind, 'carry').poseId, name: 'Carry', bones: set.carry },
            { id: aim.poseId, name: 'Aim', bones: set.aim },
            { id: poseLink(kind, 'sprint').poseId, name: 'Sprint', bones: set.sprint },
            ...set.aims.map(a => ({ id: poseLink(kind, aimKey(a.yaw, a.pitch)).poseId, name: aimVariantName(a.yaw, a.pitch), baseRef: aim, bones: a.bones })),
        ],
    }
})
const poseState = (ref: PoseLink) => ({ poseRef: ref, pose: resolvedPoseFor(weaponPoseAssets, ref)! })

// The weapons' layers: each weapon's mask, its carry blend space (its poses over the walk's axes) and its aim's (the
// aim's directions); the pistol's support hand's mask. Masks list bones by their full names.
const boneMask = (key: string, name: string, bones: string[]) => ({ id: id('mask:' + key), name, rigId: RIG_ID, weights: Object.fromEntries(bones.map(b => [b, 1])) })
const WEAPON_MASKS = {
    pistol: boneMask('pistol', 'Pistol', weaponBuild.masks.pistol),
    support: boneMask('pistolSupport', 'Pistol Support', weaponBuild.masks.support),
    rifle: boneMask('rifle', 'Rifle', weaponBuild.masks.rifle),
    aim: boneMask('aim', 'Aim', weaponBuild.masks.aim),
}
const fieldAsset2 = (key: string, name: string, f: any) => ({ id: id('field:' + key), name, rigId: RIG_ID, ...f, yAxis: f.yAxis! })
const weaponFieldAssets: any[] = []
const weaponLayers = Object.fromEntries(WEAPON_KINDS.map(kind => {
    const W = WEAPON_NAMES[kind]
    const ref = (asset: any) => { weaponFieldAssets.push(asset); return { field: toRuntimeField(asset, weaponPoseAssets), fieldId: asset.id } }
    const directions = weaponBuild.poses[kind].aims.map(a => ({ yaw: a.yaw, pitch: a.pitch, ref: poseLink(kind, aimKey(a.yaw, a.pitch)) }))
    const spec: WeaponLayerSpec = {
        mask: WEAPON_MASKS[kind],
        carry: ref(fieldAsset2(`${kind}:carry`, `${W} Carry`, poseField(field, poseLink(kind, 'carry'), poseLink(kind, 'sprint')))),
        carryPose: poseState(poseLink(kind, 'carry')),
        aim: poseState(poseLink(kind, 'aim')),
        aimOffset: ref(fieldAsset2(`${kind}:aimOffset`, `${W} Aim Offset`, aimField(directions))),
        aimMask: WEAPON_MASKS.aim,
        ...(kind === 'pistol' ? { support: { mask: WEAPON_MASKS.support } } : {}),
    }
    return [kind, spec]
})) as Record<WeaponKind, WeaponLayerSpec>
const machine = stateMachine(clips, runtimeField, FIELD_ID, speeds, LEAN_MASK, timing,
    { mask: LOOK_MASK, field: toRuntimeField(lookFieldAsset as any), fieldId: LOOK_FIELD_ID },
    stairAssets[0] ? { field: toRuntimeField(stairAssets[0].asset as any), fieldId: stairAssets[0].asset.id, up: stairAssets[0].up, down: stairAssets[0].down } : null,
    weaponLayers)
const controller = { id: CONTROLLER_ID, name: 'Mannequin Locomotion', rigId: RIG_ID, machine }

// =====================================================================================================
// The model
// =====================================================================================================

const part = character.parts[0]
const MODEL_ID = id('model:mannequin')
const modelGeometry = geometryJson(part)
const modelJson = {
    geometry: modelGeometry, material: matById(materials[0].id), materials: [matById(materials[0].id)],
    submeshes: [{ start: 0, count: part.indices.length }],
    skin: skinJson, jointIndices: part.jointIndices, jointWeights: part.jointWeights.map((w: number) => round(w, 1e4)), animations: null,
}
const materialVars = { __materialId: materials[0].id, __materialIds: JSON.stringify([materials[0].id]) }
const modelAsset = {
    id: MODEL_ID, name: 'Mannequin', textureIds: materials[0].textureIds, materialIds: [materials[0].id], thumbnail: '', rigId: RIG_ID,
    nodeJson: {
        id: id('model:root'), name: 'Mannequin', type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        variables: {}, spawnOnStart: true,
        children: [{
            id: id('model:body'), name: 'Mannequin', type: 'model', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            children: [], variables: vars(materialVars), spawnOnStart: true,
            model: modelJson, animationMappings: [], stateMachine: null, ragdoll: null,
        }],
    },
}

// The car's model, imported from its file: the body and its windows as one (two nodes: one is blended). Its wheel
// (the front left; the four are alike) is a mesh placed right under each Wheel node, which turns it.
const CAR_BODY_MODEL_ID = id('model:car:body')
const carMeshJson = (key: string, part: CarPart) => {
    const mat = carMaterialOf(part)
    return {
        id: id(`model:car:${key}`), name: part.name, type: 'model', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
        variables: vars({ __materialId: mat.id }), spawnOnStart: true,
        model: { geometry: geometryJson(part), material: matById(mat.id) },
    }
}
const carModelAsset = (mid: string, name: string, parts: [string, CarPart][]) => {
    const used = [...new Set(parts.map(([, part]) => carMaterialOf(part)))]
    return {
        id: mid, name, thumbnail: '',
        textureIds: [...new Set(used.flatMap(m => m.textureIds))], materialIds: used.map(m => m.id),
        nodeJson: {
            id: id(`model:${name}:root`), name, type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            variables: {}, spawnOnStart: true, children: parts.map(([key, part]) => carMeshJson(key, part)),
        },
    }
}
const carBodyAsset = carModelAsset(CAR_BODY_MODEL_ID, 'Car Body', [['body', car.body], ['glass', car.glass]])

// The weapons' models, from their files (weapons/models.ts): one mesh each, a submesh per material (the file's,
// those of one colour and finish merged). In weapon space: the grip at the origin, the bore along +Z, so the mesh
// goes straight under its socket.
const weaponMaterials: any[] = []
function weaponModelAsset(kind: WeaponKind) {
    const w: WeaponModel = weaponBuild.models[kind]
    const groups = new Map<string, { mat: any; parts: WeaponModel['parts'] }>()
    for (const part of w.parts) {
        const m = w.materials[part.material]
        const finish = { color: m.color.map(c => round(c, 100)), metallic: round(m.metallic, 100), roughness: round(Math.min(0.85, m.roughness), 100) }
        const key = JSON.stringify(finish)
        if (!groups.has(key)) {
            const k = groups.size
            const mat = { id: id(`mat:${kind}:${k}`), name: `${w.name} ${k + 1}`, material: pbr(finish.color, { metallic: finish.metallic, roughness: finish.roughness }), textureIds: [] }
            weaponMaterials.push(mat)
            groups.set(key, { mat, parts: [] })
        }
        groups.get(key)!.parts.push(part)
    }
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [], submeshes: { start: number; count: number }[] = []
    const mats: any[] = []
    for (const { mat, parts } of groups.values()) {
        const start = indices.length
        for (const part of parts) {
            const base = positions.length / 3
            positions.push(...part.positions); normals.push(...part.normals); uvs.push(...part.uvs)
            for (const i of part.indices) indices.push(base + i)
        }
        submeshes.push({ start, count: indices.length - start })
        mats.push(mat)
    }
    const name = w.name
    const ids = mats.map(m => m.id)
    return {
        id: WEAPON_MODEL_ID[kind], name, thumbnail: '', textureIds: [], materialIds: ids,
        nodeJson: {
            id: id(`model:${kind}:root`), name, type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], variables: {}, spawnOnStart: true,
            children: [{
                id: id(`model:${kind}:mesh`), name, type: 'model', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], spawnOnStart: true,
                variables: vars({ __materialId: ids[0], __materialIds: JSON.stringify(ids) }),
                model: {
                    geometry: geometryJson({ positions, normals, uvs, indices }), material: JSON.parse(JSON.stringify(mats[0].material)),
                    materials: mats.map(m => JSON.parse(JSON.stringify(m.material))), submeshes,
                },
            }],
        },
    }
}
const weaponAssets = Object.fromEntries(WEAPON_KINDS.map(k => [k, weaponModelAsset(k)])) as Record<WeaponKind, any>

// The shots' effects (weapons/fx.ts): the flash's and the impact's particle systems, the bullet hole's texture and
// material, the tracer's glowing material.
const SHOT_PARTICLES = shotParticleSystems(k => id('fx:' + k), k => parseInt(id('seed:' + k).slice(0, 6), 16))
const HOLE_TEX = textures.addBytes(id('tex:bullet-hole'), bulletHolePng(), { wrapping: 'clamp', mipMap: true, mipMapFilter: 'linear' })
textureFolders.push({ id: HOLE_TEX, folder: '/Weapons/Effects/Textures', name: 'Bullet Hole' })
const FX_MATERIALS = {
    hole: { id: id('mat:fx:hole'), name: 'Bullet Hole', material: pbr([1, 1, 1], { roughness: 0.9, textures: { baseColorTexture: HOLE_TEX }, config: { ...config, castShadow: false } }), textureIds: [HOLE_TEX] },
    tracer: {
        id: id('mat:fx:tracer'), name: 'Tracer', textureIds: [],
        // A glow, like the flash's: a tenth of the camera's exposure, so it reads the same by day and by night.
        material: pbr([1, 0.85, 0.5], { roughness: 0.85, emissiveFactor: [1, 0.78, 0.4], emissiveIntensity: 6, emissiveExposureWeight: GLOW_EXPOSURE_WEIGHT, config: { ...config, castShadow: false } }),
    },
}
const fxNode = (key: string, name: string, type: string, extra: any = {}) => ({
    id: id(`fx:${key}`), name, type, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], variables: {}, spawnOnStart: true, ...extra,
})
/** A particle system node; a glow's (`glow`) brightened by the camera's exposure only by GLOW_EXPOSURE_WEIGHT. */
const particleNode = (key: string, name: string, asset: any, glow: boolean, extra: any = {}) => fxNode(key, name, 'particleSystem', {
    particleSystem: {
        system: JSON.parse(JSON.stringify(asset.system)), particleSystemId: asset.id, playOnStart: true, simulationSpeed: 1, spawnRateScale: 1, tint: [1, 1, 1, 1],
        ...(glow ? { exposureWeight: GLOW_EXPOSURE_WEIGHT } : {}),
    },
    ...extra,
})
/** The four effect templates SandboxGun spawns: each its root, its script, and what it is made of. */
function shotEffectTemplates() {
    const flash = fxNode('flash', FX_NAMES.flash, 'node', {
        children: [
            // The particles fire along +Y: turned along the bore (+Z).
            particleNode('flash:ps', 'Flash', SHOT_PARTICLES.flash, true, { rotation: [90, 0, 0] }),
            particleNode('flash:smoke', 'Smoke', SHOT_PARTICLES.flashSmoke, false, { rotation: [90, 0, 0] }),
            fxNode('flash:light', 'Light', 'light', {
                position: [0, 0, FLASH_LIGHT.ahead], lightType: 'point', castShadows: false, bake: false,
                light: { unit: 'photometric', color: FLASH_LIGHT.color, intensity: FLASH_LIGHT.lumens, range: FLASH_LIGHT.range, sourceRadius: 0.05, legacyFalloff: false },
            }),
        ],
    })
    withScript(flash, shotFxScript, { lifetime: 0.7, lightFalloff: 4 })
    const impact = fxNode('impact', FX_NAMES.impact, 'node', {
        children: [particleNode('impact:ps', 'Sparks', SHOT_PARTICLES.impact, true), particleNode('impact:dust', 'Dust', SHOT_PARTICLES.impactDust, false)],
    })
    withScript(impact, shotFxScript, { lifetime: 1.6 })
    const hole = fxNode('hole', FX_NAMES.hole, 'node', {
        children: [fxNode('hole:decal', 'Hole', 'decal', {
            variables: vars({ __materialId: FX_MATERIALS.hole.id }),
            decal: {
                size: HOLE_DECAL.size, opacity: 1, sortOrder: 0, angleFade: HOLE_DECAL.angleFade, depthFade: HOLE_DECAL.depthFade,
                affects: { albedo: true, normal: false, surface: true, emissive: false }, receivers: 'all', pattern: 'material',
                material: JSON.parse(JSON.stringify(FX_MATERIALS.hole.material)),
            },
        })],
    })
    withScript(hole, holeScript, {})
    // The streak runs back from the root (its head) along -Z.
    const tracer = fxNode('tracer', FX_NAMES.tracer, 'node', {
        children: [fxNode('tracer:streak', 'Streak', 'model', {
            position: [0, 0, -TRACER.length / 2], scale: [TRACER.thickness, TRACER.thickness, TRACER.length],
            variables: vars({ __materialId: FX_MATERIALS.tracer.id }),
            model: { geometry: geometryOf('box', () => Geometry.Cube(1, 1, 1)), material: JSON.parse(JSON.stringify(FX_MATERIALS.tracer.material)) },
        })],
    })
    withScript(tracer, tracerScript, { trail: TRACER.length })
    return [flash, impact, hole, tracer].map(root => templatizeSubtree(root, id('template:fx:' + root.name), root.name))
}

// =====================================================================================================
// Scripts
// =====================================================================================================

const playerSource = fs.readFileSync(path.join(SCRIPTS, 'SandboxPlayer.ts'), 'utf8')
const playerScript = { id: id('script:SandboxPlayer'), name: 'SandboxPlayer', baseType: 'character', source: playerSource, kind: 'class', variables: parseScriptVariables(playerSource) }
const cameraSource = fs.readFileSync(path.join(SCRIPTS, 'SandboxCamera.ts'), 'utf8')
const cameraScript = { id: id('script:SandboxCamera'), name: 'SandboxCamera', baseType: 'cameraRig', source: cameraSource, kind: 'class', variables: parseScriptVariables(cameraSource) }
const carSource = fs.readFileSync(path.join(SCRIPTS, 'SandboxCar.ts'), 'utf8')
const carScript = { id: id('script:SandboxCar'), name: 'SandboxCar', baseType: 'collider', source: carSource, kind: 'class', variables: parseScriptVariables(carSource) }
const carCameraSource = fs.readFileSync(path.join(SCRIPTS, 'SandboxCarCamera.ts'), 'utf8')
const carCameraScript = { id: id('script:SandboxCarCamera'), name: 'SandboxCarCamera', baseType: 'cameraRig', source: carCameraSource, kind: 'class', variables: parseScriptVariables(carCameraSource) }
const managerSource = fs.readFileSync(path.join(SCRIPTS, 'SandboxGameManager.ts'), 'utf8')
const managerScript = { id: id('script:SandboxGameManager'), name: 'SandboxGameManager', baseType: 'node', source: managerSource, kind: 'class', variables: parseScriptVariables(managerSource) }
const scriptOf = (name: string, baseType: string) => {
    const source = fs.readFileSync(path.join(SCRIPTS, `${name}.ts`), 'utf8')
    return { id: id('script:' + name), name, baseType, source, kind: 'class', variables: parseScriptVariables(source) }
}
// The guns, and their effects' lifetimes.
const gunScript = scriptOf('SandboxGun', 'node')
const shotFxScript = scriptOf('SandboxShotFx', 'node')
const tracerScript = scriptOf('SandboxTracer', 'node')
const holeScript = scriptOf('SandboxBulletHole', 'node')
const WEAPON_SCRIPTS = [gunScript, shotFxScript, tracerScript, holeScript]
const scriptAssets = [playerScript, cameraScript, carScript, carCameraScript, managerScript, ...WEAPON_SCRIPTS]
/**
 * Each gun's handling (SandboxGun's attributes): the pistol fires once a pull, the rifle while held; the rifle
 * kicks less a shot but fires faster and pushes harder.
 */
const GUN_VARS: Record<WeaponKind, Record<string, unknown>> = {
    pistol: { auto: false, roundsPerMinute: 420, impulse: 14, aimSpread: 0.3, hipSpread: 2.2, moveSpread: 2.5, bloomPerShot: 0.6, bloomMax: 2.5, recoilPitch: 1.6, recoilYaw: 0.4, kick: 7 },
    rifle: { auto: true, roundsPerMinute: 700, impulse: 12, aimSpread: 0.25, hipSpread: 2.8, moveSpread: 3, bloomPerShot: 0.35, bloomMax: 3, recoilPitch: 0.9, recoilYaw: 0.45, kick: 4 },
}
function withScript(json: any, asset: any, scriptVars: Record<string, unknown>) {
    const known = new Set(asset.variables.map((v: any) => v.name))
    for (const key of Object.keys(scriptVars)) if (!known.has(key)) throw new Error(`${asset.name} has no field "${key}"`)
    json.variables = { ...(json.variables ?? {}), ...vars({ __scriptId: asset.id }) }
    json.script = asset.source
    json.scriptVars = scriptVars
}

// =====================================================================================================
// The scene
// =====================================================================================================

const geometryCache = new Map<string, any>()
const geometryOf = (key: string, make: () => Geometry) => {
    if (!geometryCache.has(key)) {
        const g = make()
        geometryCache.set(key, {
            positions: Array.from(g.positions, v => round(v)), normals: Array.from(g.normals, v => round(v)),
            tangents: Array.from(g.tangents), bitangents: Array.from(g.bitangents), texCoords: Array.from(g.uvs, v => round(v)), indices: Array.from(g.indices),
        })
    }
    return geometryCache.get(key)
}

/** Placeholder ids -> the model JSON put back after the engine has serialized the rest. */
const models = new Map<string, any>()
const placeholder = (nid: string, name: string, transform: any = {}) =>
    ({ id: nid, name, type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], ...transform })
const modelNode = (key: string, name: string, materialId: string, model: any, transform: any = {}) => {
    const nid = id('node:' + key)
    models.set(nid, {
        id: nid, name, type: 'model', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], spawnOnStart: true,
        variables: vars({ __materialId: materialId }), model,
    })
    return placeholder(nid, name, transform)
}

/**
 * One level piece: a static collider holding its mesh, as an editor-placed prop is (two for a flight of stairs). The
 * engine's merge pass then folds them into the scene's Static Collision colliders, one per collision layer.
 */
function pieceNodes(p: Piece, i: number): any[] {
    const key = `level:${i}:${p.name}`
    const mid = LEVEL_MAT[p.material]
    const material = matById(mid)
    if (p.kind === 'box') {
        const mesh = modelNode(key, p.name, mid, { geometry: geometryOf('box', () => Geometry.Cube(1, 1, 1)), material })
        return [{
            type: 'collider', id: id(key + ':collider'), name: `${p.name} Collider`, position: p.position, rotation: p.rotation ?? [0, 0, 0], scale: p.size,
            collider: {
                mass: 0, ...(p.layer ? { layer: PIECE_LAYER[p.layer] } : {}),
                shapes: [{ type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }],
            },
            children: [mesh],
        }]
    }
    if (p.kind === 'cylinder') {
        const mesh = modelNode(key, p.name, mid, { geometry: geometryOf('cylinder', () => Geometry.Cylinder(24, 0.5, 1)), material })
        return [{
            type: 'collider', id: id(key + ':collider'), name: `${p.name} Collider`, position: p.position, rotation: [0, 0, 0], scale: [p.radius * 2, p.height, p.radius * 2],
            collider: {
                mass: 0, ...(p.layer ? { layer: PIECE_LAYER[p.layer] } : {}),
                shapes: [{ type: 'cylinder', radius: 0.5, height: 1, numSegments: 24, offset: [0, 0, 0], rotation: [0, 0, 0] }],
            },
            children: [mesh],
        }]
    }
    // A ramp or a flight of stairs: the visible mesh scaled to size, and a slab under the walking line (unscaled, so
    // its rotation stays exact). A ramp's line is its surface. A flight's runs from the ground half a tread before the
    // first riser to the landing's front edge: only the capsule walks it (the feet stand on the steps), so it can meet
    // the landing flush. One through the treads' middles stopped half a tread short of the landing, and the capsule
    // hopped off its crest at a jog (Rapier).
    const [w, h, d] = p.size
    const run = p.kind === 'stairs' ? d / p.steps : 0
    const span = d + run / 2
    const L = Math.hypot(h, span), t = 0.4, a = Math.atan2(h, span)
    const n = [0, span / L, -h / L]
    // The line's middle, from (z -d/2 - run/2, y -h/2) to (z d/2, y h/2); the box sits under it.
    const centre = [0, -n[1] * t / 2, -run / 4 - n[2] * t / 2]
    const slab = { type: 'box', width: w, height: t, depth: L, offset: centre, rotation: [-a * 180 / Math.PI, 0, 0] }
    const mesh = modelNode(key, p.name, mid, {
        geometry: p.kind === 'ramp' ? geometryOf('ramp', () => Geometry.Ramp(1, 1, 1)) : geometryOf(`stairs:${p.steps}`, () => Geometry.Stairs(p.steps, 1, 1, 1)),
        material,
    }, { scale: [w, h, d] })
    const placed = { position: p.position, rotation: [0, p.yaw ?? 0, 0], scale: [1, 1, 1] }
    if (p.kind === 'ramp')
        return [{ type: 'collider', id: id(key + ':collider'), name: `${p.name} Collider`, ...placed, collider: { mass: 0, shapes: [slab] }, children: [mesh] }]
    // A flight of stairs is two colliders. Its steps, a box per step from the ground to its tread (as
    // Geometry.Stairs lays them: climbing toward +Z), on Foot Detail: what the feet, the props and the camera
    // meet, and what the mesh stands in. And the slab, on Stair Ramp, which only the Character layer collides
    // with: what the capsule glides up, since a capsule has no step-up of its own.
    const rise = h / p.steps
    const steps = Array.from({ length: p.steps }, (_, k) => ({
        type: 'box', width: w, height: round((k + 1) * rise), depth: round(run),
        offset: [0, round(-h / 2 + (k + 1) * rise / 2), round(-d / 2 + (k + 0.5) * run)], rotation: [0, 0, 0],
    }))
    return [
        {
            type: 'collider', id: id(key + ':collider'), name: `${p.name} Collider`, ...placed,
            collider: { mass: 0, layer: LAYERS.FOOT_DETAIL, shapes: steps }, children: [mesh],
        },
        {
            type: 'collider', id: id(key + ':ramp'), name: `${p.name} Ramp`, ...placed,
            collider: { mass: 0, layer: LAYERS.STAIR_RAMP, mask: LAYERS.CHARACTER, shapes: [slab] }, children: [],
        },
    ]
}

/**
 * One prop: a rigid body holding its mesh, the shape and the mesh both a unit primitive sized by the collider's
 * scale, as a level piece is, but with mass. Sleeps when still, so a course of them costs nothing at rest.
 */
function propNode(p: Prop, i: number): any {
    const k = PROP_KINDS[p.name]
    const key = `prop:${i}:${p.name}`
    const mid = PROP_MAT[k.material]
    const geometry = k.shape === 'box' ? geometryOf('box', () => Geometry.Cube(1, 1, 1))
        : k.shape === 'sphere' ? geometryOf('sphere', () => Geometry.Sphere(24, 0.5))
        : geometryOf('cylinder', () => Geometry.Cylinder(24, 0.5, 1))
    const shape = k.shape === 'box' ? { type: 'box', width: 1, height: 1, depth: 1 }
        : k.shape === 'sphere' ? { type: 'sphere', radius: 0.5 }
        : { type: 'cylinder', radius: 0.5, height: 1, numSegments: 16 }
    const mesh = modelNode(key, p.name, mid, { geometry, material: matById(mid) })
    return {
        type: 'collider', id: id(key + ':collider'), name: `${p.name} Collider`, position: p.position, rotation: p.rotation ?? [0, 0, 0], scale: k.size,
        collider: {
            mass: k.mass, friction: 0.5, restitution: k.restitution ?? 0, linearDamping: 0.05, angularDamping: k.angularDamping ?? 0.1,
            // Small things do not pull the camera in: on No Camera, which the rig is not blocked by.
            canSleep: true, ...(k.camera ? {} : { layer: LAYERS.NO_CAMERA }),
            shapes: [{ ...shape, offset: [0, 0, 0], rotation: [0, 0, 0] }],
        },
        children: [mesh],
    }
}

const MODEL_NODE_ID = id('player:mannequin')
/** The player script's field values, attached after the engine has serialized the tree (it drops inline scripts). */
let characterScriptVars: Record<string, unknown> = {}
const RIG_ID_CAMERA = id('player:rig')
const TEMPLATE_ID = id('template:player')
const ENVIRONMENT_TEMPLATE_ID = id('template:environment')
const COURSE_TEMPLATE_ID = id('template:course')
/** The camera script's framing, attached with it after serialization (the character's, so public). */
const CAMERA_VARS = { thirdPersonArm: 3.4, shoulderArm: 1.9, shoulderOffset: 0.5, aimArm: 1.25, aimShoulderOffset: 0.6, pivotHeight: 1.45 }
const CHARACTER_ID = id('player:character')
const capsuleHeight = round(character.height, 1e3)

function cameraRig(rid: string, name: string, cameraName: string, o: any) {
    return {
        type: 'cameraRig', id: rid, name, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        followId: MODEL_NODE_ID, aimMode: 'orbit', followSpace: 'world', followDampingSpace: 'rig',
        yaw: SPAWN.yaw, collisionEnabled: true, collisionRadius: 0.2, collisionPullTime: 0, collisionReturnTime: 0.35,
        collisionLayers: CAMERA_BLOCKED_BY, seeThroughLayers: LAYERS.SEE_THROUGH,
        ...o,
        children: [{ type: 'camera', id: rid + ':camera', name: cameraName, camera: { type: 'perspective', fov: 60, near: 0.05, far: 2000, left: -1, right: 1, bottom: -1, top: 1 }, active: true }],
    }
}

/**
 * The weapons, on the Mannequin's right hand: each held by its grip socket (`Pistol Grip`, `Rifle Grip`: the socket's
 * frame is the weapon's), its model straight under it, and a Muzzle point at the end of its bore. SandboxPlayer shows
 * the one in the hands and hides the other.
 */
function weaponsNode() {
    return {
        type: 'node', id: id('player:weapons'), name: 'Weapons', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        children: WEAPON_KINDS.map(kind => ({
            type: 'node', id: id(`player:weapon:${kind}`), name: WEAPON_SOCKETS[kind], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            socketAttachment: { target: 'parent', socket: WEAPON_SOCKETS[kind] },
            children: [
                carInstance(`player:weapon:${kind}:model`, weaponAssets[kind]),
                { type: 'node', id: id(`player:weapon:${kind}:muzzle`), name: 'Muzzle', position: rounded(weaponBuild.models[kind].muzzle), rotation: [0, 0, 0], scale: [1, 1, 1], children: [] },
            ],
        })),
    }
}

function playerNode() {
    const mannequin = {
        id: MODEL_NODE_ID, name: 'Mannequin', type: 'model', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [], spawnOnStart: true,
        variables: vars({ __modelId: MODEL_ID, ...materialVars }),
        model: JSON.parse(JSON.stringify(modelJson)), animationMappings: [],
        stateMachine: { ...JSON.parse(JSON.stringify(machine)), controllerId: CONTROLLER_ID }, ragdoll: null,
    }
    models.set(MODEL_NODE_ID, mannequin)
    const characterNode: any = {
        type: 'character', id: CHARACTER_ID, name: 'Player', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        walkSpeed: round(speeds.jog, 1e3), runSpeed: round(speeds.sprint, 1e3), jumpSpeed: TUNING.jumpSpeed,
        // Direction smoothing small: the direction is the real travel now, which turn friction already turns smoothly;
        // more smoothing only lags the legs behind it.
        // The turn in place waits (SandboxPlayer's turnDelay writes these every frame): the head looks round first.
        turnSpeed: 480, turnThreshold: 70, turnReleaseAngle: 48, turnSettleSeconds: 1, turnSettleFarSeconds: 0.35, directionSmoothing: 0.05,
        acceleration: round(acceleration, 10), airControl: 0.25, coyoteSeconds: 0.1, jumpBufferSeconds: 0.15, jumpLockoutSeconds: 0.22,
        // The velocity turns toward a new direction keeping its speed (Unreal's ground friction), and the blend
        // space reads where the body really goes: with the acceleration alone a change of direction coasts the
        // old way at a dip in speed while the legs already play the new one, which reads as ice.
        turnFriction: 8, moveDirSource: 'velocity',
        // It stands on the stairs' ramps (25 and 32 degrees) and the course's ramps up to 40 without sliding.
        slopeLimit: 45,
        facingMode: 'aim', driveWhenUnpossessed: false,
        children: [
            // One rig: SandboxCamera frames it over the shoulder, and eases it out to third person while sprinting.
            cameraRig(RIG_ID_CAMERA, 'Camera Rig', 'Camera', {
                followOffset: [0, CAMERA_VARS.pivotHeight + 0.05, 0], followDamping: [0.08, 0.18, 0.14],
                armLength: CAMERA_VARS.shoulderArm, socketOffset: [-CAMERA_VARS.shoulderOffset, 0.1, 0],
                pitch: 12, pitchMin: -55, pitchMax: 70, aimDamping: 0.05,
            }),
            placeholder(MODEL_NODE_ID, 'Mannequin'),
            weaponsNode(),
            {
                type: 'controller', id: id('player:controller'), name: 'Player Controller', possessedId: CHARACTER_ID, controlSource: 'player',
                moveAction: 'Move', lookAction: 'Look', jumpAction: 'Jump', sprintAction: 'Sprint', crouchAction: '',
                aimSource: 'node', aimSourceId: RIG_ID_CAMERA, driveAimTarget: true,
            },
        ],
    }
    characterScriptVars = {
        walkScale: round(speeds.walk / speeds.jog, 1e3),
        backScale: round(speeds.back, 1e3),
        backDiagonalScale: round(speeds.jogDiagonal, 1e3),
        walkBackDiagonalScale: round(speeds.walkDiagonal, 1e3),
        walkFootSpeed: round(speeds.walk * 1.2, 1e3),
        runFootSpeed: round(speeds.jog * 0.9, 1e3),
        sprintTakeoff: round(speeds.takeoff!, 100),
        // A flight's pace, horizontal: one tread a step at the stair clips' rate (machine.ts stairPaces).
        stairUpWalkSpeed: paces.upWalk, stairUpRunSpeed: paces.upRun,
        stairDownWalkSpeed: paces.downWalk, stairDownRunSpeed: paces.downRun,
    }
    return {
        type: 'collider', id: id('player:collider'), name: 'Player Collider', position: SPAWN.position, rotation: [0, SPAWN.yaw, 0], scale: [1, 1, 1],
        collider: {
            mass: TUNING.mass, friction: 0, restitution: 0, linearDamping: 0, angularDamping: 0,
            linearConstraints: [1, 1, 1], angularConstraints: [0, 0, 0], groundProbeDistance: 0.12, simulationMode: 'always',
            layer: LAYERS.CHARACTER, mask: CHARACTER_MASK,
            shapes: [{ type: 'capsule', radius: TUNING.capsuleRadius, height: capsuleHeight, numSegments: 16, offset: [0, capsuleHeight / 2, 0], rotation: [0, 0, 0] }],
        },
        children: [characterNode],
    }
}

// =====================================================================================================
// The car
// =====================================================================================================

const CAR_ID = id('car:collider')
const CAR_TEMPLATE_ID = id('template:car')
const CAR_VEHICLE_ID = id('car:vehicle')
const CAR_RIG_ID = id('car:rig')
const CAR_TARGET_ID = id('car:target')
/** The Car preset's chassis mass, kg (vehiclePresets.ts): kept when the chassis is sized to the body. */
const CAR_MASS = 1200
/** The wheels' springs: the Car preset's 1.5 Hz sinks the body this far onto them at rest (g / (2 pi f)^2). */
const CAR_SPRING_HZ = 1.5
const CAR_SAG = 9.82 / (2 * Math.PI * CAR_SPRING_HZ) ** 2
/** The car's camera framing (SandboxCarCamera): behind and above, out of the driver's own. */
const CAR_CAMERA_VARS = { chaseArm: 6.5, chaseHeight: 1.6 }
/** Where the driver sits, gets in and gets out (car.ts seatPoints), from the clips. */
const carClip = (name: string) => clips.get(name)!.car!
const seats = seatPoints(carClip('CarEnter').seated, carClip('CarEnter').motion, carClip('CarExit').motion)
console.log(`car: ${CAR_FIT.size} of its own size, ${(car.max[2] - car.min[2]).toFixed(2)} m long and ${car.max[1].toFixed(2)} m tall; seated hips ${CAR_FIT.seatHips.toFixed(3)} m up`)
console.log(`car: seat ${seats.seat.map(v => v.toFixed(3)).join(', ')}; enter point ${seats.enterPoint.map(v => v.toFixed(3)).join(', ')}; exit point ${seats.exitPoint.map(v => v.toFixed(3)).join(', ')}; `
    + `wheels r ${car.wheels[0].radius.toFixed(3)} w ${car.wheels[0].width.toFixed(3)}, spring sag ${(CAR_SAG * 100).toFixed(1)} cm`)
/** The wheels, by the order the Car preset fills them in: front left, front right, rear left, rear right. */
const CAR_WHEEL_ORDER = ['FL', 'FR', 'RL', 'RR'] as const
/** Each wheel's place, the hub as modelled with the spring at full stretch: lower by the sag, so the body sits as modelled. */
const carWheelPosition = (corner: string) => {
    const w = car.wheels.find(x => x.corner === corner)!
    return rounded([w.centre[0], w.centre[1] - CAR_SAG, w.centre[2]])
}
const posed = (key: string, name: string, pose: YawPose, extra: any = {}) => ({
    type: 'node', id: id(key), name, position: rounded(pose.slice(0, 3)), rotation: [0, Math.round(pose[3] * 100) / 100, 0], scale: [1, 1, 1], children: [], ...extra,
})

/**
 * A model asset placed: its nodes (placeholders for the meshes, put back after the engine serializes), tagged as its
 * instance. Named as the asset is: the editor rebuilds a placed model from its asset, under the asset's name, and a
 * hull's `sources` find it by that name.
 */
function carInstance(key: string, asset: any, transform: any = {}) {
    const name = asset.name
    const meshes = asset.nodeJson.children.map((m: any) => {
        const nid = id(`${key}:${m.id}`)
        models.set(nid, { ...JSON.parse(JSON.stringify(m)), id: nid })
        return placeholder(nid, m.name)
    })
    return {
        type: 'node', id: id(key), name, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...transform,
        variables: vars({ __modelId: asset.id }), children: meshes,
    }
}

/**
 * The chassis: one convex hull of the body and its windows, not the wheels (the Vehicle's wheels are rays, not
 * shapes), built from the Car Body model's meshes as the editor's Add Convex Hull would with only it ticked.
 */
const CAR_CHASSIS = { ...convexShape(ROOT, [car.body, car.glass], 'high'), sources: [carBodyAsset.name] }

/** A wheel's mesh, right under its Wheel node (which turns it): turned round on the right, so its hub faces out there too. */
function carWheelMesh(corner: string) {
    const nid = id('car:wheel-mesh:' + corner)
    models.set(nid, { ...carMeshJson('wheel:' + corner, car.wheel), id: nid })
    return placeholder(nid, car.wheel.name, corner.endsWith('R') ? { rotation: [0, 180, 0] } : {})
}

/**
 * The car's lamps, as lights its script switches (SandboxCar): a pair of each, left and right. Their intensities are
 * what they give when on (the tail lamps: braking); the script turns them off, on and down.
 *
 *   Headlight     spot lights on the headlamps, ahead and a little down, casting shadows
 *   Tail Light    red, at the tail lamps: dim with someone in the car, bright while it brakes
 *   Reverse Light white, at the reversing lamps: on in reverse
 */
const CAR_LIGHTS = {
    head: { color: [1, 0.93, 0.8], intensity: 30000, range: 45, sourceRadius: 0.06, cutOff: 16, outerCutOff: 32, tilt: 4 },
    tail: { color: [1, 0.04, 0.02], intensity: 120, range: 3, sourceRadius: 0.05 },
    reverse: { color: [1, 0.96, 0.9], intensity: 220, range: 5, sourceRadius: 0.05 },
}
function carLights() {
    const lamp = (key: string, name: string, at: number[], lightType: string, light: any, rotation = [0, 0, 0], castShadows = false) =>
        (['L', 'R'] as const).map(side => ({
            type: 'light', id: id(`car:light:${key}:${side}`), name: `${name} ${side}`,
            // The car's left is +X.
            position: rounded([side === 'L' ? at[0] : -at[0], at[1], at[2]], 1e3), rotation, scale: [1, 1, 1], children: [],
            lightType, light: { unit: 'photometric', ...light }, castShadows, bake: false,
        }))
    const { head, tail, reverse } = CAR_LIGHTS
    return {
        type: 'node', id: id('car:lights'), name: 'Lights', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        children: [
            ...lamp('head', 'Headlight', car.lamps.head, 'spotlight',
                { color: head.color, intensity: head.intensity, range: head.range, sourceRadius: head.sourceRadius, cutOff: head.cutOff, outerCutOff: head.outerCutOff },
                [head.tilt, 0, 0], true),
            ...lamp('tail', 'Tail Light', car.lamps.tail, 'point', { color: tail.color, intensity: tail.intensity, range: tail.range, sourceRadius: tail.sourceRadius }),
            ...lamp('reverse', 'Reverse Light', car.lamps.reverse, 'point', { color: reverse.color, intensity: reverse.intensity, range: reverse.range, sourceRadius: reverse.sourceRadius }),
        ],
    }
}

function carNode() {
    const wheels = CAR_WHEEL_ORDER.map(corner => {
        const w = car.wheels.find(x => x.corner === corner)!
        return {
            type: 'wheel', id: id('car:wheel:' + corner), name: `Wheel ${corner}`, position: carWheelPosition(corner), rotation: [0, 0, 0], scale: [1, 1, 1],
            radius: round(w.radius, 1e3), width: round(w.width, 1e3),
            children: [carWheelMesh(corner)],
        }
    })
    // The Door Zone: a box beside the driver's door, round where getting in starts.
    const zone = { width: 2.2, height: 2, depth: 2.6 }
    const zoneX = round(car.halfWidth + zone.width / 2 - 0.2, 1e3)
    return {
        type: 'collider', id: CAR_ID, name: 'Car', position: CAR.position, rotation: [0, CAR.yaw, 0], scale: [1, 1, 1],
        collider: {
            mass: CAR_MASS, friction: 0.5, restitution: 0, linearDamping: 0, angularDamping: 0, simulationMode: 'always',
            layer: LAYERS.VEHICLE, shapes: [CAR_CHASSIS],
        },
        children: [
            carInstance('car:body', carBodyAsset),
            carLights(),
            {
                type: 'vehicle', id: CAR_VEHICLE_ID, name: 'Vehicle', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
                drivetrain: 'engine', playerInput: false, parked: true,
                children: [{ type: 'node', id: id('car:wheels'), name: 'Wheels', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: wheels }],
            },
            posed('car:seat', 'Seat', seats.seat, {
                children: [
                    posed('car:enter', 'Enter Point', yawLocal(seats.seat, seats.enterPoint)),
                    posed('car:exit', 'Exit Point', yawLocal(seats.seat, seats.exitPoint)),
                ],
            }),
            {
                type: 'trigger', id: id('car:door'), name: 'Door Zone', position: [zoneX, zone.height / 2, round(seats.enterPoint[2], 1e3)], rotation: [0, 0, 0], scale: [1, 1, 1],
                sensor: { layer: LAYERS.DEFAULT, mask: LAYERS.CHARACTER, shapes: [{ type: 'box', ...zone, offset: [0, 0, 0], rotation: [0, 0, 0] }] },
                children: [],
            },
            { type: 'node', id: CAR_TARGET_ID, name: 'Camera Target', position: [0, CAR_CAMERA_VARS.chaseHeight, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [] },
            {
                type: 'cameraRig', id: CAR_RIG_ID, name: 'Car Camera Rig', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
                followId: CAR_TARGET_ID, followOffset: [0, 0, 0], aimMode: 'orbit', followSpace: 'world', followDampingSpace: 'rig', followDamping: [0.05, 0.08, 0.05],
                yaw: CAR.yaw, pitch: 12, pitchMin: -40, pitchMax: 60, aimDamping: 0.05, armLength: CAR_CAMERA_VARS.chaseArm, socketOffset: [0, 0.3, 0],
                collisionEnabled: true, collisionRadius: 0.2, collisionPullTime: 0, collisionReturnTime: 0.35,
                collisionLayers: CAMERA_BLOCKED_BY, seeThroughLayers: LAYERS.SEE_THROUGH,
                children: [{ type: 'camera', id: CAR_RIG_ID + ':camera', name: 'Car Camera', camera: { type: 'perspective', fov: 60, near: 0.05, far: 2000, left: -1, right: 1, bottom: -1, top: 1 }, active: false }],
            },
            {
                // Drive (inputMap.ts), not Move: on a pad the triggers are the pedals and the left stick only steers.
                type: 'controller', id: id('car:controller'), name: 'Car Controller', possessedId: null, controlSource: 'player',
                moveAction: 'Drive', lookAction: 'Look', jumpAction: 'Jump', sprintAction: '', crouchAction: '',
                aimSource: 'node', aimSourceId: CAR_RIG_ID, driveAimTarget: true,
            },
        ],
    }
}

/** `pose` (in the car's frame) in the frame of `parent` (also in the car's). */
function yawLocal(parent: YawPose, pose: YawPose): YawPose {
    const [x, y, z] = rotateByYaw(pose[0] - parent[0], pose[1] - parent[1], pose[2] - parent[2], -parent[3])
    return [x, y, z, pose[3] - parent[3]]
}

/** The Car preset's settings on the parsed Vehicle, laid out on this car: its wheels where the mesh has them, its chassis its body. */
function fitCarPreset(root: Node) {
    const find = (n: Node): Node | null => n.id === CAR_VEHICLE_ID ? n : n.children.reduce<Node | null>((hit, c) => hit ?? find(c), null)
    const vehicleNode = find(root) as unknown as VehicleNode | null
    if (!vehicleNode || vehicleNode.nodeType !== 'vehicle') throw new Error('the car has no Vehicle node: is the vehicles feature installed?')
    const chassis = vehicleNode.collider as any
    const shapes = JSON.parse(JSON.stringify(chassis.shapes)), mass = chassis.mass
    if (!vehicleNode.applyPreset('car')) throw new Error('no Car vehicle preset')
    chassis.shapes = shapes
    chassis.mass = mass
    const wheels = vehicleNode.wheels
    if (wheels.length !== 4) throw new Error(`the Car preset left ${wheels.length} wheels`)
    wheels.forEach((w, i) => {
        const corner = CAR_WHEEL_ORDER[i], data = car.wheels.find(x => x.corner === corner)!
        w.setPosition(carWheelPosition(corner) as any)
        w.radius = round(data.radius, 1e3)
        w.width = round(data.width, 1e3)
    })
    vehicleNode.parked = true
    vehicleNode.playerInput = false
}

/** Nothing of the course stands where the car is parked, nor in its Door Zone (a box round the car and its door). */
function checkCarSpot(pieces: Piece[], placed: Prop[]) {
    const reach = 3.5   // half its length and a margin
    const near = (p: number[]) => Math.hypot(p[0] - CAR.position[0], p[2] - CAR.position[2]) < reach + 1
    const blocked = [
        ...pieces.filter(p => p.name !== 'Ground' && near(p.position)).map(p => p.name),
        ...placed.filter(p => near(p.position)).map(p => p.name),
    ]
    if (blocked.length) throw new Error(`the car's spot is not clear: ${blocked.join(', ')}`)
}

/**
 * The eye, for the day, the dusk and the night alike (set once, never ramped: docs/scripting/rendering.md): it adapts
 * as far down as the night needs (exposureMinEV), and the compensation curve, keyed on the metered EV, keeps the dark
 * looking dark: the day (metered EV 15.6) as metered, the dusk (EV 1.4, the GI and the light probe lighting the course
 * with the sky's own bounce) 2.35 stops under, the moonlit night (EV 0.7) 3.3 under.
 */
const EXPOSURE = { exposureMinEV: -3, exposureCompensationCurve: [[-2, -4], [0.5, -3.6], [1.5, -2.35], [6, -1.2], [10, -0.4], [13, 0]] }

/** The clouds' settings over the Sunset preset. */
const CLOUDS = { coverage: 0.6, baseScale: 0.0013, detailScale: 0.007, hazeDistance: 9000 }

/** The ground the course stands on: 120 m square, its top at y 0 (level.ts). */
const FLOOR = { side: 120 }

/**
 * The GI Volume over the whole floor: one layer of probes (one along Y, at the middle of the box: 2 m up, where a
 * character stands), 20 by 20 across (a probe every 6 m), inset half a spacing so the outer ones stand inside the
 * barrier. The box reaches 2 m under the ground and 6 m over it, so the floor and everything up to the platforms'
 * tops sit well inside its feather. Captured when the scene loads (no saved bake); the editor's Bake keeps one.
 */
const GI = { across: 20, bottom: -2, top: 6, rays: 64, maxRayDistance: 60, blendDistance: 1 }
function giVolumeNode() {
    const n = GI.across
    return {
        type: 'giVolume', id: id('node:gi-volume'), name: 'GI Volume', position: [0, (GI.bottom + GI.top) / 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        variables: {}, spawnOnStart: true, children: [],
        giVolume: {
            size: [FLOOR.side, GI.top - GI.bottom, FLOOR.side], probeCounts: [n, 1, n], probeInset: 0.5, rays: GI.rays,
            maxRayDistance: GI.maxRayDistance, captureResolution: 32, includeGrass: false, blendDistance: GI.blendDistance,
            intensity: 1, normalBias: 0.1, viewBias: 0.4, multiBounce: true, additive: false, enabled: true, bakeId: null,
        },
    }
}

/**
 * A light probe over the whole scene: its reflections everywhere, and its light where the GI Volume does not reach
 * (over the platforms' tops), captured from the middle of the course at a standing height.
 */
function lightProbeNode() {
    return {
        type: 'lightProbe', id: id('node:light-probe'), name: 'Light Probe', position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        variables: {}, spawnOnStart: true, children: [],
        resolution: 256, mode: 'baked', updateFrequency: 1, intensity: 1, size: [FLOOR.side, 40, FLOOR.side], blendDistance: 2,
        affectsLighting: true, affectsReflections: true, boxProjection: false,
        // It relights itself once the sun has turned a degree: the Game Manager's light setups move it.
        relightDegrees: 1,
    }
}

/** The open ocean round the course: its surface 2 m under the ground's top, a young sea under a fresh breeze. */
const OCEAN = { level: -2, windSpeed: 8, fetch: 5000, waveDirection: 25, choppiness: 0.6 }
const OCEAN_MATERIAL = {
    id: id('material:ocean'), name: 'Ocean', textureIds: [], thumbnail: '',
    material: new WaterMaterial({ ...WATER_LOOK_PRESETS.find(p => p.id === 'openOcean')!.options }).serialize(),
}
async function oceanNode() {
    const node = new WaterVolumeNode('Ocean', { waterType: 'ocean', depth: 200 }, id('node:ocean'))
    node.setPosition([0, OCEAN.level, 0])
    const json: any = await node.serialize()
    json.waterVolume = {
        ...json.waterVolume, density: 1025, windSpeed: OCEAN.windSpeed, fetch: OCEAN.fetch, waveDirection: OCEAN.waveDirection,
        choppiness: OCEAN.choppiness, followWind: false, waterMaterialId: OCEAN_MATERIAL.id, waterMaterial: OCEAN_MATERIAL.material,
        waterType: 'ocean',
    }
    json.children = []
    return json
}

/** The Game Manager: SandboxGameManager, its light setups on 1, 2 and 3. */
function gameManagerNode() {
    const json: any = {
        type: 'node', id: id('node:game-manager'), name: 'Game Manager', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        variables: {}, spawnOnStart: true, children: [],
    }
    withScript(json, managerScript, {})
    return json
}

/**
 * The HUD: a panel in the top left corner saying which light setup is on (the Game Manager writes it) and the keys,
 * over the reference 1920 x 1080 screen.
 */
async function hudNode() {
    const hud = new UIRootNode('HUD', 'screen', id('node:hud'))
    const panel = new UIPanelNode('Controls', id('node:hud:panel'))
    panel.anchorMin = [0, 0]; panel.anchorMax = [0, 0]
    panel.offsetMin = [24, 24]; panel.offsetMax = [700, 200]
    panel.borderRadius = 10
    hud.addChild(panel)
    const line = (key: string, name: string, text: string, top: number, size: number, weight = 400) => {
        const t = new UITextNode(name, id('node:hud:' + key))
        t.anchorMin = [0, 0]; t.anchorMax = [0, 0]
        t.offsetMin = [18, top]; t.offsetMax = [600, top + size * 1.4]
        t.fontSize = size; t.fontWeight = weight; t.align = 'left'; t.wrap = false
        t.text = text
        panel.addChild(t)
    }
    line('light', 'Light Setup', 'Light: Sunset', 14, 28, 600)
    line('keys', 'Light Keys', '1 Day  ·  2 Sunset  ·  3 Night', 58, 22)
    line('moves', 'Moves', 'WASD move · Shift sprint · Ctrl walk · Space jump · E car', 100, 20)
    line('weapons', 'Weapon Keys', 'Q pistol / rifle / none · Right mouse aim · Left mouse fire', 134, 20)
    // The crosshair, in the middle of the screen where the shots go: a dot and four ticks, which SandboxPlayer shows
    // with a weapon out and moves out as the shot spreads.
    const crosshair = new UIPanelNode('Crosshair', id('node:hud:crosshair'))
    crosshair.anchorMin = [0.5, 0.5]; crosshair.anchorMax = [0.5, 0.5]
    crosshair.offsetMin = [-40, -40]; crosshair.offsetMax = [40, 40]
    crosshair.tint = [0, 0, 0, 0]
    crosshair.opacity = 0
    hud.addChild(crosshair)
    const mark = (key: string, name: string, min: [number, number], max: [number, number], radius = 0) => {
        const m = new UIPanelNode(name, id('node:hud:crosshair:' + key))
        m.anchorMin = [0.5, 0.5]; m.anchorMax = [0.5, 0.5]
        m.offsetMin = min; m.offsetMax = max
        m.tint = [1, 1, 1, 0.9]
        m.borderRadius = radius
        crosshair.addChild(m)
    }
    mark('dot', 'Crosshair Dot', [-1.5, -1.5], [1.5, 1.5], 1.5)
    mark('top', 'Crosshair Top', [-1, -15], [1, -8])
    mark('bottom', 'Crosshair Bottom', [-1, 8], [1, 15])
    mark('left', 'Crosshair Left', [-15, -1], [-8, 1])
    mark('right', 'Crosshair Right', [8, -1], [15, 1])
    return await hud.serialize()
}

async function buildScene() {
    const env = JSON.parse(fs.readFileSync(path.join(HERE, 'environment.json'), 'utf8'))
    const root = new Node('root', 'node', id('node:root'))
    // The props under one node of their own, so the tree reads: the environment, the player, the props, the course.
    const propsRoot = { type: 'node', id: id('node:props'), name: 'Props', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: props().map(propNode) }
    checkCarSpot(course(), props())
    const trees = [playerNode(), carNode(), propsRoot, ...course().flatMap(pieceNodes)]
    for (const t of trees) parseNodeJson(root, t)
    fitCarPreset(root)
    root.updateTransforms(null)
    const children: any[] = []
    for (const c of root.children) children.push(await c.serialize())
    // Put the models back where their placeholders are.
    const restore = (n: any): any => {
        const m = models.get(n.id)
        const out = m ? { ...m, position: n.position, rotation: n.rotation, scale: n.scale } : n
        out.children = (n.children ?? []).map(restore)
        if (out.id === CHARACTER_ID) withScript(out, playerScript, characterScriptVars)
        if (out.id === RIG_ID_CAMERA) withScript(out, cameraScript, CAMERA_VARS)
        if (out.id === CAR_ID) withScript(out, carScript, {})
        if (out.id === CAR_RIG_ID) withScript(out, carCameraScript, CAR_CAMERA_VARS)
        for (const kind of WEAPON_KINDS) if (out.id === id(`player:weapon:${kind}`)) withScript(out, gunScript, GUN_VARS[kind])
        return out
    }
    // Dusk: the sun 9 degrees under the horizon (the end of civil twilight), so the car's lamps show; its glow is still
    // on the horizon. The Game Manager moves it for its day and night (SandboxGameManager).
    const sun = { ...env.sun, id: id('node:sun'), name: 'Sun', rotation: [-9, 35, 0], light: { unit: 'photometric', color: [1, 0.95, 0.88], intensity: 95000, angularRadius: 0.01 }, castShadows: true, children: [] }
    delete sun.bake
    const sky = { ...env.sky, id: id('node:sky'), name: 'Sky Atmosphere', children: [] }
    sky.atmosphere = { ...sky.atmosphere, fogDensity: 0.00015, fogMaxOpacity: 0.25, godRaysEnabled: false }
    const skyLight = { ...env.skyLight, id: id('node:skylight'), name: 'Sky Light', children: [] }
    // The clouds: the Sunset preset (their bases lit warm from under the horizon), with more of them (coverage 0.6),
    // smaller (base noise 0.0013, detail 0.007) and fading into the sky from 9 km (haze distance).
    const cloudsNode = new VolumetricCloudsNode('Volumetric Clouds', {}, id('node:clouds'))
    if (!cloudsNode.applyPreset('sunset')) throw new Error('no Sunset clouds preset')
    Object.assign(cloudsNode, CLOUDS)
    const clouds = { ...(await cloudsNode.serialize()), children: [] }
    // The sky, the sun, the sky light and the clouds under one root: the Environment template.
    const environment = {
        id: id('node:environment'), name: 'Environment', type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        variables: {}, spawnOnStart: true, children: [sun, sky, skyLight, clouds],
    }
    const scene = {
        id: id('node:root'), name: 'root', type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], variables: {}, spawnOnStart: true,
        children: [environment, await oceanNode(), giVolumeNode(), lightProbeNode(), gameManagerNode(), await hudNode(), ...children.map(restore)],
        ambientLight: [15.6, 16.7, 20],
    }
    const environmentTemplate = templatizeSubtree(environment, ENVIRONMENT_TEMPLATE_ID, 'Environment')
    // Everything that is the character, as a template: the Collider, the Character and its script, the camera rig
    // and its script, the model, the Controller. The scene holds one instance of it, at the spawn.
    const playerRoot = scene.children.find((c: any) => c.name === 'Player Collider')
    const playerTemplate = templatizeSubtree(playerRoot, TEMPLATE_ID, 'Player')
    // The car, the same way: its chassis, body, wheels, seat, camera rig, Controller and scripts (before the merge,
    // which never touches a dynamic collider anyway).
    const carRoot = scene.children.find((c: any) => c.id === CAR_ID)
    const carTemplate = templatizeSubtree(carRoot, CAR_TEMPLATE_ID, 'Car')
    const merged = mergeStaticColliders(scene, { scriptStrings: new Set(), idFor: k => id('merge:' + k), layerNames: LAYER_NAMES })
    if (merged.kept.length) throw new Error(`level colliders left unmerged: ${merged.kept.join('; ')}`)
    console.log(`level: ${merged.merged} pieces in ${merged.colliders.map(c => `${c.name} (${c.shapes} shapes)`).join(', ')}`)
    // The merged course, as a template of its own (after the merge: the merge leaves a template instance alone).
    // The placement keeps the examples' name for merged scenery, Static Collision. What is merged apart for its layer
    // (the feet's detail, the stairs' ramps, the see-through pillars) goes inside it: one Course, four bodies.
    const courseRoot = scene.children.find((c: any) => c.type === 'collider' && c.name === 'Static Collision')
    if (!courseRoot) throw new Error('no merged Static Collision to make the Course of')
    const layered = scene.children.filter((c: any) => c !== courseRoot && c.type === 'collider' && /^Static Collision \(/.test(c.name))
    const expected = ['Static Collision (Foot Detail)', 'Static Collision (See Through)', 'Static Collision (Stair Ramp)']
    if (layered.map((c: any) => c.name).sort().join() !== expected.join())
        throw new Error(`expected ${expected.join(', ')} merged apart, found ${layered.map((c: any) => c.name).join(', ')}`)
    scene.children = scene.children.filter((c: any) => !layered.includes(c))
    courseRoot.children.push(...layered)
    const courseTemplate = templatizeSubtree(courseRoot, COURSE_TEMPLATE_ID, 'Course')
    const again = mergeStaticColliders(JSON.parse(JSON.stringify(scene)), { scriptStrings: new Set(), idFor: k => k })
    if (again.merged) throw new Error('the merged level still has colliders to merge')
    // Every prop placed more than once is a template, its copies linked instances of it (crates, barrels, balls).
    const madeProps = templatizeScene(scene, { takenNames: new Set(['Player', 'Environment', 'Course', 'Car']), idFor: k => id('template:prop:' + k) })
    const propTemplates = madeProps.templates.map(m => m.template)
    console.log(`props: ${madeProps.templates.map(m => `${m.template.name} x${m.instances}`).join(', ')}`)
    const t = templatizeScene(JSON.parse(JSON.stringify(scene)), { takenNames: new Set(), idFor: k => k })
    if (t.log.length) throw new Error(`groups placed more than once without a template: ${t.log.join('; ')}`)
    const render = { ...env.render, dofEnabled: false, lensFlareIntensity: 0, chromaticAberrationStrength: 0.1, exposureCompensation: 0.3, ...EXPOSURE }
    return { scene, config: { graphics: env.graphics, render }, templates: [playerTemplate, environmentTemplate, courseTemplate, carTemplate, ...propTemplates, ...shotEffectTemplates()] }
}

// =====================================================================================================
// Write
// =====================================================================================================

async function main() {
    fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    fs.mkdirSync(path.join(OUT, 'libraries'), { recursive: true })
    fs.mkdirSync(path.join(OUT, 'scenes'), { recursive: true })
    const { scene, config, templates } = await buildScene()
    // The node fields (the Game Manager's sun, HUD line and probe), pointed at their nodes (nodeFields.mjs).
    console.log(`node fields: ${applyNodeFields(scene, scriptAssets, (m: string) => console.log(m))} set`)

    const libraries: Record<string, unknown[]> = {
        models: [modelAsset, carBodyAsset, weaponAssets.pistol, weaponAssets.rifle], materials: [...materials, ...carMaterials, ...weaponMaterials, ...Object.values(FX_MATERIALS), OCEAN_MATERIAL], terrainMaterials: [],
        animationFields: [fieldAsset, lookFieldAsset, ...stairAssets.map(a => a.asset), ...weaponFieldAssets], animControllers: [controller],
        boneMasks: [LEAN_MASK, LOOK_MASK, WEAPON_MASKS.pistol, WEAPON_MASKS.support, WEAPON_MASKS.rifle, WEAPON_MASKS.aim],
        animations, rigs: [rig], tilesets: [], scripts: scriptAssets, templates, particleSystems: Object.values(SHOT_PARTICLES), aiBrains: [],
        poseAssets: weaponPoseAssets,
    }
    for (const [name, value] of Object.entries(libraries)) writeJson(path.join(OUT, 'libraries', `${name}.json`), value)
    writeJson(path.join(OUT, 'libraries', 'inputMap.json'), sandboxInputMap())
    // The project's settings: the default ones (Project Settings parses what is absent as its default), and the
    // collision layers' names, which every layer picker shows.
    writeJson(path.join(OUT, 'libraries', 'projectSettings.json'), { version: 6, collisionLayers: LAYER_NAMES })

    const hashes: Record<string, string> = {}
    const written = (name: string) => JSON.parse(fs.readFileSync(path.join(OUT, 'libraries', `${name}.json`), 'utf8'))
    for (const [kind, lib] of [['material', 'materials'], ['model', 'models'], ['script', 'scripts'], ['template', 'templates']] as const)
        for (const asset of written(lib)) hashes[assetHashKey(kind as any, asset.id)] = hashAsset(asset)
    writeJson(path.join(OUT, 'scenes', `${SCENE_ID}.json`), {
        scene, textures: [], ui: { version: 1, elements: [] }, config,
        assetHashes: hashes, assetHashVersion: ASSET_HASH_VERSION, savedAt: CREATED_AT,
    })
    const textureCount = textures.write(OUT)

    writeJson(path.join(OUT, 'manifest.json'), {
        formatVersion: 1, kind: 'project', createdAt: CREATED_AT, projectName: PROJECT,
        mainSceneId: SCENE_ID, openSceneId: SCENE_ID,
        sceneMetas: [{
            id: SCENE_ID, name: PROJECT, updatedAt: CREATED_AT, dimension: '3D',
            refs: {
                version: SCENE_REFS_VERSION,
                materialIds: [...materials, ...carMaterials, ...weaponMaterials, ...Object.values(FX_MATERIALS), OCEAN_MATERIAL].map(m => m.id), modelIds: [MODEL_ID, CAR_BODY_MODEL_ID, WEAPON_MODEL_ID.pistol, WEAPON_MODEL_ID.rifle], templateIds: templates.map((t: any) => t.id), terrainMaterialIds: [], tilesetIds: [],
                aiBrainIds: [], textureIds: textures.included, scriptIds: scriptAssets.map(s => s.id), animationFieldIds: [FIELD_ID, LOOK_FIELD_ID, ...stairAssets.map(a => a.asset.id), ...weaponFieldAssets.map(a => a.id)],
                foliageModelIds: [], soundSampleIds: [], audioSourceIds: [], animationIds: animations.map(a => a.id), particleSystemIds: Object.values(SHOT_PARTICLES).map(p => p.id),
            },
        }],
    })

    // The Assets panel: by what a thing is.
    const entries: any[] = []
    const add = (folder: string, name: string, kind: string, assetId: string) =>
        entries.push({ path: `${folder}/${name}${(KIND_EXT as any)[kind]}`, kind, assetId, created: CREATED_AT })
    add('/Scenes', PROJECT, 'scene', SCENE_ID)
    add('/Characters/Mannequin', 'Mannequin', 'model', MODEL_ID)
    add('/Characters/Mannequin', 'Mannequin', 'rig', RIG_ID)
    add('/Characters/Mannequin/Animation', 'Locomotion', 'animationField', FIELD_ID)
    add('/Characters/Mannequin/Animation', 'Look', 'animationField', LOOK_FIELD_ID)
    for (const a of stairAssets) add('/Characters/Mannequin/Animation', a.asset.name, 'animationField', a.asset.id)
    add('/Characters/Mannequin/Animation', 'Mannequin Locomotion', 'animController', CONTROLLER_ID)
    add('/Characters/Mannequin', LEAN_MASK.name, 'boneMask', LEAN_MASK.id)
    add('/Characters/Mannequin', LOOK_MASK.name, 'boneMask', LOOK_MASK.id)
    for (const m of [WEAPON_MASKS.pistol, WEAPON_MASKS.support, WEAPON_MASKS.rifle, WEAPON_MASKS.aim]) add('/Characters/Mannequin', m.name, 'boneMask', m.id)
    for (const a of weaponFieldAssets) add('/Characters/Mannequin/Animation/Weapons', a.name, 'animationField', a.id)
    for (const a of weaponPoseAssets) add('/Characters/Mannequin/Animation/Weapons', a.name, 'pose', a.id)
    for (const kind of WEAPON_KINDS) {
        add('/Weapons', weaponAssets[kind].name, 'model', WEAPON_MODEL_ID[kind])
        for (const m of weaponMaterials.filter(m => m.name.startsWith(WEAPON_NAMES[kind] + ' '))) add('/Weapons/Materials', m.name, 'material', m.id)
    }
    for (const a of animations) add('/Characters/Mannequin/Animation/Clips', a.name, 'animation', a.id)
    add('/Characters/Mannequin/Materials', 'Mannequin', 'material', materials[0].id)
    add('/Characters/Mannequin/Scripts', 'SandboxPlayer', 'script', playerScript.id)
    add('/Characters/Mannequin/Scripts', 'SandboxCamera', 'script', cameraScript.id)
    add('/Characters/Mannequin', 'Player', 'template', TEMPLATE_ID)
    add('/Level', 'Environment', 'template', ENVIRONMENT_TEMPLATE_ID)
    add('/Level', 'Course', 'template', COURSE_TEMPLATE_ID)
    add('/Vehicles/Car', 'Car', 'template', CAR_TEMPLATE_ID)
    add('/Vehicles/Car', 'Car Body', 'model', CAR_BODY_MODEL_ID)
    for (const m of carMaterials) add('/Vehicles/Car/Materials', m.name, 'material', m.id)
    add('/Vehicles/Car/Scripts', 'SandboxCar', 'script', carScript.id)
    add('/Vehicles/Car/Scripts', 'SandboxCarCamera', 'script', carCameraScript.id)
    add('/Level/Materials', 'Ocean', 'material', OCEAN_MATERIAL.id)
    add('/Level/Scripts', 'SandboxGameManager', 'script', managerScript.id)
    const effectNames = new Set<string>(Object.values(FX_NAMES))
    for (const tpl of templates.slice(4)) add(effectNames.has(tpl.name) ? '/Weapons/Effects' : '/Level/Props', tpl.name, 'template', tpl.id)
    for (const s of WEAPON_SCRIPTS) add('/Weapons/Scripts', s.name, 'script', s.id)
    for (const m of Object.values(FX_MATERIALS)) add('/Weapons/Effects/Materials', m.name, 'material', m.id)
    for (const p of Object.values(SHOT_PARTICLES)) add('/Weapons/Effects', p.name, 'particleSystem', p.id)
    for (const m of materials.slice(1)) add('/Level/Materials', m.name, 'material', m.id)
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
        description: 'A locomotion sandbox in the style of Advanced Locomotion System v4: a mannequin that walks and jogs in eight directions facing the camera, sprints freely, sets off, stops and turns round with their own clips, leans into curves, turns in place when you look away, jumps, falls and lands soft or hard, climbs stairs, with its feet planted and locked by IK on ramps, stairs and bumps. And a car to get into (E by the driver\'s door) and drive on the vehicle simulation. A pistol and a rifle to carry, aim and fire (Q, right mouse, left mouse), held over the walk by a layer each, their shots raycasts that push what they hit. All of it is the animator, the Character, Controller and Vehicle nodes and a few input-only scripts. Car model: "Dirty car" by 3D Error 404 (CC-BY-4.0). Weapons: "Low-Poly G40" and "Low-Poly M4a1" by TastyTony (CC-BY-4.0).',
        order: 5,
    })
    const largest = await packFormat2(OUT)
    console.log(`Sandbox written: ${animations.length} clips, ${textureCount} textures, ${machine.states.length} states, ${machine.transitions.length} transitions; largest file ${(largest / 1048576).toFixed(1)} MB`)
    for (const w of warnings) console.log('warning: ' + w)
}

await main()
